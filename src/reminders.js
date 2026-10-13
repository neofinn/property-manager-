'use strict';

// Computes everything that needs attention: rent due/overdue, unpaid bills,
// agreements about to expire, documents expiring or awaiting verification,
// and upcoming appointments.

const MAX_RENT_LOOKBACK_MONTHS = 12;

function pad(n) {
  return String(n).padStart(2, '0');
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

function monthName(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function makeMoney(currency) {
  let fmt;
  try {
    fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  }
  return (n) => fmt.format(n);
}

function digitsOnly(phone) {
  return phone ? String(phone).replace(/[^\d]/g, '') : '';
}

function contactLinks(phone, email, subject, message) {
  const digits = digitsOnly(phone);
  return {
    whatsapp: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null,
    sms: digits ? `sms:${digits}?body=${encodeURIComponent(message)}` : null,
    email: email ? `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` : null,
  };
}

// Rent due for one agreement in one period, or null if not due in that period.
function dueDateFor(agreement, period) {
  const due = `${period}-${pad(agreement.rent_due_day || 1)}`;
  // First month: rent is due on move-in if the usual due day has already passed.
  if (due < agreement.start_date) {
    return agreement.start_date.slice(0, 7) === period ? agreement.start_date : null;
  }
  if (due > agreement.end_date) return null;
  return due;
}

function rentReminders(db, today, horizon, money) {
  const agreements = db
    .prepare(
      `SELECT a.*, tn.full_name AS tenant_name, tn.phone AS tenant_phone, tn.email AS tenant_email,
              p.name AS property_name
       FROM agreements a
       JOIN tenants tn ON tn.id = a.tenant_id
       JOIN properties p ON p.id = a.property_id
       WHERE a.status = 'Active'`,
    )
    .all();
  const paidStmt = db.prepare(
    'SELECT period, SUM(amount) AS paid FROM rent_payments WHERE agreement_id = ? GROUP BY period',
  );
  const lastDate = addDays(today, horizon);
  const items = [];

  for (const a of agreements) {
    const paid = new Map(paidStmt.all(a.id).map((r) => [r.period, r.paid]));
    let period = a.start_date.slice(0, 7);
    const earliest = addMonths(today.slice(0, 7), -(MAX_RENT_LOOKBACK_MONTHS - 1));
    if (period < earliest) period = earliest;
    const lastPeriod = lastDate.slice(0, 7);

    for (; period <= lastPeriod; period = addMonths(period, 1)) {
      const due = dueDateFor(a, period);
      if (!due || due > lastDate) continue;
      const paidAmount = paid.get(period) || 0;
      const outstanding = Math.round((a.monthly_rent - paidAmount) * 100) / 100;
      if (outstanding <= 0) continue;

      const daysLate = daysBetween(due, today);
      const state = daysLate > 0 ? 'overdue' : daysLate === 0 ? 'due_today' : 'upcoming';
      const when =
        state === 'overdue'
          ? `was due on ${due} (${daysLate} day${daysLate === 1 ? '' : 's'} overdue)`
          : state === 'due_today'
            ? 'is due today'
            : `is due on ${due}`;
      const message =
        `Hi ${a.tenant_name}, this is a friendly reminder that the rent of ${money(outstanding)} ` +
        `for ${monthName(period)} at ${a.property_name} ${when}. ` +
        `Please ignore this message if you have already paid. Thank you!`;

      items.push({
        key: `rent:${a.id}:${period}`,
        type: 'rent',
        state,
        agreement_id: a.id,
        tenant_id: a.tenant_id,
        property_id: a.property_id,
        tenant_name: a.tenant_name,
        tenant_phone: a.tenant_phone,
        property_name: a.property_name,
        period,
        due_date: due,
        rent: a.monthly_rent,
        paid: paidAmount,
        outstanding,
        days_overdue: Math.max(daysLate, 0),
        message,
        links: contactLinks(a.tenant_phone, a.tenant_email, `Rent reminder – ${monthName(period)}`, message),
      });
    }
  }
  return items.sort((x, y) => x.due_date.localeCompare(y.due_date));
}

function billReminders(db, today, horizon) {
  return db
    .prepare(
      `SELECT b.*, p.name AS property_name FROM bills b JOIN properties p ON p.id = b.property_id
       WHERE b.status = 'Unpaid' AND b.due_date <= ? ORDER BY b.due_date`,
    )
    .all(addDays(today, horizon))
    .map((b) => {
      const daysLate = daysBetween(b.due_date, today);
      return {
        key: `bill:${b.id}`,
        type: 'bill',
        state: daysLate > 0 ? 'overdue' : daysLate === 0 ? 'due_today' : 'upcoming',
        bill_id: b.id,
        property_id: b.property_id,
        property_name: b.property_name,
        category: b.category,
        provider: b.provider,
        payer: b.payer,
        amount: b.amount,
        due_date: b.due_date,
        days_overdue: Math.max(daysLate, 0),
      };
    });
}

function agreementReminders(db, today, money, windowDays = 60) {
  return db
    .prepare(
      `SELECT a.*, tn.full_name AS tenant_name, tn.phone AS tenant_phone, tn.email AS tenant_email,
              p.name AS property_name
       FROM agreements a JOIN tenants tn ON tn.id = a.tenant_id JOIN properties p ON p.id = a.property_id
       WHERE a.status = 'Active' AND a.end_date <= ? ORDER BY a.end_date`,
    )
    .all(addDays(today, windowDays))
    .map((a) => {
      const daysLeft = daysBetween(today, a.end_date);
      const message =
        daysLeft < 0
          ? `Hi ${a.tenant_name}, your rent agreement for ${a.property_name} ended on ${a.end_date}. Please get in touch to renew it.`
          : `Hi ${a.tenant_name}, your rent agreement for ${a.property_name} ends on ${a.end_date}. Please let us know whether you would like to renew (current rent ${money(a.monthly_rent)}).`;
      return {
        key: `agreement:${a.id}:${a.end_date}`,
        type: 'agreement',
        state: daysLeft < 0 ? 'expired' : 'expiring',
        agreement_id: a.id,
        tenant_id: a.tenant_id,
        property_id: a.property_id,
        tenant_name: a.tenant_name,
        tenant_phone: a.tenant_phone,
        property_name: a.property_name,
        end_date: a.end_date,
        days_left: daysLeft,
        message,
        links: contactLinks(a.tenant_phone, a.tenant_email, 'Rent agreement renewal', message),
      };
    });
}

function documentReminders(db, today, windowDays = 30) {
  const label =
    `COALESCE((SELECT full_name FROM tenants WHERE id = d.tenant_id), ` +
    `(SELECT name FROM properties WHERE id = d.property_id))`;
  const expiring = db
    .prepare(
      `SELECT d.id, d.title, d.doc_type, d.expires_on, ${label} AS related
       FROM documents d WHERE d.expires_on IS NOT NULL AND d.expires_on <= ? ORDER BY d.expires_on`,
    )
    .all(addDays(today, windowDays))
    .map((d) => ({
      key: `document:${d.id}:expiry`,
      type: 'document_expiry',
      state: d.expires_on < today ? 'expired' : 'expiring',
      document_id: d.id,
      title: d.title,
      doc_type: d.doc_type,
      related: d.related,
      expires_on: d.expires_on,
      days_left: daysBetween(today, d.expires_on),
    }));
  const unverified = db
    .prepare(
      `SELECT d.id, d.title, d.doc_type, d.created_at, ${label} AS related
       FROM documents d WHERE COALESCE(d.verified, 0) = 0 ORDER BY d.created_at`,
    )
    .all()
    .map((d) => ({
      key: `document:${d.id}:verify`,
      type: 'document_unverified',
      state: 'pending',
      document_id: d.id,
      title: d.title,
      doc_type: d.doc_type,
      related: d.related,
    }));
  return { expiring, unverified };
}

function scheduleReminders(db, today, horizon) {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT name FROM properties WHERE id = s.property_id) AS property_name,
              (SELECT full_name FROM tenants WHERE id = s.tenant_id) AS tenant_name,
              (SELECT name FROM contacts WHERE id = s.contact_id) AS contact_name,
              (SELECT phone FROM contacts WHERE id = s.contact_id) AS contact_phone
       FROM schedules s
       WHERE s.status = 'Scheduled' AND s.starts_at < ? ORDER BY s.starts_at`,
    )
    .all(`${addDays(today, horizon + 1)}T00:00`);
  return rows.map((s) => ({
    key: `schedule:${s.id}`,
    type: 'schedule',
    state: s.starts_at.slice(0, 10) < today ? 'missed' : s.starts_at.slice(0, 10) === today ? 'today' : 'upcoming',
    schedule_id: s.id,
    title: s.title,
    kind: s.kind,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    property_name: s.property_name,
    tenant_name: s.tenant_name,
    contact_name: s.contact_name,
    contact_phone: s.contact_phone,
  }));
}

function attachLastReminded(db, items) {
  const stmt = db.prepare(
    'SELECT channel, sent_at FROM reminder_log WHERE reminder_key = ? ORDER BY id DESC LIMIT 1',
  );
  for (const item of items) {
    const last = stmt.get(item.key);
    item.last_reminded = last ? { channel: last.channel, sent_at: last.sent_at } : null;
  }
  return items;
}

function computeReminders(db, { today = localToday(), horizon = 7, currency = 'INR' } = {}) {
  const money = makeMoney(currency);
  const rent = attachLastReminded(db, rentReminders(db, today, horizon, money));
  const agreements = attachLastReminded(db, agreementReminders(db, today, money));
  const docs = documentReminders(db, today);
  return {
    today,
    horizon,
    rent,
    bills: billReminders(db, today, horizon),
    agreements,
    documents_expiring: docs.expiring,
    documents_unverified: docs.unverified,
    schedules: scheduleReminders(db, today, horizon),
  };
}

function computeDashboard(db, { today = localToday(), horizon = 7, currency = 'INR' } = {}) {
  const count = (table, where = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;
  const period = today.slice(0, 7);
  const occupied = db
    .prepare(
      `SELECT COUNT(DISTINCT property_id) AS n FROM agreements
       WHERE status = 'Active' AND start_date <= ? AND end_date >= ?`,
    )
    .get(today, today).n;
  const expected = db
    .prepare(
      `SELECT COALESCE(SUM(monthly_rent), 0) AS s FROM agreements
       WHERE status = 'Active' AND substr(start_date, 1, 7) <= ? AND substr(end_date, 1, 7) >= ?`,
    )
    .get(period, period).s;
  const collected = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM rent_payments WHERE period = ?')
    .get(period).s;
  const reminders = computeReminders(db, { today, horizon, currency });
  const overdueRent = reminders.rent.filter((r) => r.state === 'overdue');

  return {
    today,
    period,
    counts: {
      properties: count('properties'),
      tenants: count('tenants', "WHERE status = 'Active'"),
      agreements: count('agreements', "WHERE status = 'Active'"),
      contacts: count('contacts'),
      documents: count('documents'),
      unpaid_bills: count('bills', "WHERE status = 'Unpaid'"),
    },
    occupancy: { occupied, total: count('properties') },
    rent: {
      expected_this_month: expected,
      collected_this_month: collected,
      overdue_total: Math.round(overdueRent.reduce((s, r) => s + r.outstanding, 0) * 100) / 100,
      overdue_count: overdueRent.length,
    },
    bills_unpaid_total: db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM bills WHERE status = 'Unpaid'").get().s,
    reminders,
  };
}

module.exports = { computeReminders, computeDashboard, localToday, addDays, addMonths, dueDateFor };
