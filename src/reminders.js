'use strict';

// Computes everything that needs attention in PG Manager: rent due/overdue,
// unpaid expenses, guests checking out or arriving soon, and documents
// expiring or awaiting verification.

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

// "Sunrise PG, B4"
function placeName(row) {
  return [row.pg_name, row.bed_label].filter(Boolean).join(', ');
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

// Rent due for one guest in one period, or null if not due in that period.
// The first month's rent is due on check-in; later months on the due day,
// and nothing after the check-out month.
function dueDateFor(guest, period) {
  const due = `${period}-${pad(guest.due_day || 1)}`;
  const start = guest.check_in;
  if (start && start.slice(0, 7) === period) return due < start ? start : due;
  if (start && due < start) return null;
  if (guest.check_out && period > guest.check_out.slice(0, 7)) return null;
  return due;
}

const GUEST_SQL = `SELECT g.*, p.name AS pg_name, COALESCE(g.rent_due_day, p.rent_due_day, 5) AS due_day,
       (SELECT bed_label FROM beds WHERE id = g.bed_id) AS bed_label
  FROM guests g LEFT JOIN pgs p ON p.id = g.pg_id`;

async function rentReminders(db, today, horizon, money) {
  const guests = await db.all(`${GUEST_SQL} WHERE g.status = 'Active' AND COALESCE(g.rent, 0) > 0`);
  const paidRows = await db.all(
    `SELECT guest_id, period, SUM(amount) AS paid FROM payments
     WHERE kind = 'Rent' AND guest_id IN (SELECT id FROM guests WHERE status = 'Active')
     GROUP BY guest_id, period`,
  );
  const paidBy = new Map(paidRows.map((r) => [`${r.guest_id}|${r.period}`, r.paid]));
  const lastDate = addDays(today, horizon);
  const earliest = addMonths(today.slice(0, 7), -(MAX_RENT_LOOKBACK_MONTHS - 1));
  const items = [];

  for (const g of guests) {
    const place = placeName(g);
    let period = (g.check_in || today).slice(0, 7);
    if (period < earliest) period = earliest;
    for (; period <= lastDate.slice(0, 7); period = addMonths(period, 1)) {
      const due = dueDateFor(g, period);
      if (!due || due > lastDate) continue;
      const paid = paidBy.get(`${g.id}|${period}`) || 0;
      const outstanding = Math.round((g.rent - paid) * 100) / 100;
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
        `Hi ${g.full_name}, this is a friendly reminder that the rent of ${money(outstanding)} ` +
        `for ${monthName(period)}${place ? ` at ${place}` : ''} ${when}. ` +
        `Please ignore this message if you have already paid. Thank you!`;
      items.push({
        key: `rent:${g.id}:${period}`,
        type: 'rent',
        state,
        guest_id: g.id,
        guest_name: g.full_name,
        guest_phone: g.phone,
        pg_id: g.pg_id,
        place,
        period,
        due_date: due,
        rent: g.rent,
        paid,
        outstanding,
        days_overdue: Math.max(daysLate, 0),
        message,
        links: contactLinks(g.phone, g.email, `Rent reminder – ${monthName(period)}`, message),
      });
    }
  }
  return items.sort((x, y) => x.due_date.localeCompare(y.due_date));
}

async function billReminders(db, today, horizon) {
  const rows = await db.all(
    `SELECT b.*, p.name AS pg_name FROM bills b JOIN pgs p ON p.id = b.pg_id
     WHERE b.status = 'Unpaid' AND b.due_date <= ? ORDER BY b.due_date`,
    addDays(today, horizon),
  );
  return rows.map((b) => {
    const daysLate = daysBetween(b.due_date, today);
    return {
      key: `bill:${b.id}`,
      type: 'bill',
      state: daysLate > 0 ? 'overdue' : daysLate === 0 ? 'due_today' : 'upcoming',
      bill_id: b.id,
      pg_id: b.pg_id,
      pg_name: b.pg_name,
      category: b.category,
      provider: b.provider,
      amount: b.amount,
      due_date: b.due_date,
      days_overdue: Math.max(daysLate, 0),
    };
  });
}

// Active guests checking out and bookings arriving within `windowDays`.
async function stayReminders(db, today, money, windowDays = 7) {
  const until = addDays(today, windowDays);
  const leaving = await db.all(`${GUEST_SQL} WHERE g.status = 'Active' AND g.check_out IS NOT NULL AND g.check_out <= ? ORDER BY g.check_out`, until);
  const arriving = await db.all(`${GUEST_SQL} WHERE g.status = 'Booked' AND (g.check_in IS NULL OR g.check_in <= ?) ORDER BY g.check_in`, until);
  const item = (g, type, date) => {
    const place = placeName(g);
    const days = date ? daysBetween(today, date) : null;
    const message =
      type === 'checkout'
        ? `Hi ${g.full_name}, a reminder that your check-out${place ? ` from ${place}` : ''} is on ${date}. Please clear any dues${g.deposit ? ` (deposit ${money(g.deposit)} will be settled at check-out)` : ''}. Thank you!`
        : `Hi ${g.full_name}, your bed${place ? ` at ${place}` : ''} is booked${date ? ` from ${date}` : ''}. We look forward to welcoming you!`;
    return {
      key: `${type}:${g.id}:${date || ''}`,
      type,
      state: days === null ? 'pending' : days < 0 ? 'overdue' : days === 0 ? 'today' : 'upcoming',
      guest_id: g.id,
      guest_name: g.full_name,
      guest_phone: g.phone,
      place,
      date,
      days_left: days,
      message,
      links: contactLinks(g.phone, g.email, type === 'checkout' ? 'Check-out reminder' : 'Your booking', message),
    };
  };
  return [...leaving.map((g) => item(g, 'checkout', g.check_out)), ...arriving.map((g) => item(g, 'arrival', g.check_in))];
}

async function documentReminders(db, today, windowDays = 30) {
  const label = `COALESCE((SELECT full_name FROM guests WHERE id = d.guest_id), (SELECT name FROM pgs WHERE id = d.pg_id))`;
  const expiring = (
    await db.all(
      `SELECT d.id, d.title, d.doc_type, d.expires_on, ${label} AS related
       FROM documents d WHERE d.expires_on IS NOT NULL AND d.expires_on <= ? ORDER BY d.expires_on`,
      addDays(today, windowDays),
    )
  ).map((d) => ({
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
  const unverified = (
    await db.all(
      `SELECT d.id, d.title, d.doc_type, d.created_at, ${label} AS related
       FROM documents d WHERE COALESCE(d.verified, 0) = 0 ORDER BY d.created_at`,
    )
  ).map((d) => ({
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

async function attachLastReminded(db, items) {
  const last = new Map();
  for (let i = 0; i < items.length; i += 200) {
    const keys = items.slice(i, i + 200).map((item) => item.key);
    const rows = await db.all(
      `SELECT reminder_key, channel, sent_at FROM reminder_log
       WHERE reminder_key IN (${keys.map(() => '?').join(', ')}) ORDER BY id`,
      ...keys,
    );
    for (const r of rows) last.set(r.reminder_key, { channel: r.channel, sent_at: r.sent_at });
  }
  for (const item of items) item.last_reminded = last.get(item.key) || null;
  return items;
}

async function computeReminders(db, { today = localToday(), horizon = 7, currency = 'INR' } = {}) {
  const money = makeMoney(currency);
  const docs = await documentReminders(db, today);
  return {
    today,
    horizon,
    rent: await attachLastReminded(db, await rentReminders(db, today, horizon, money)),
    bills: await billReminders(db, today, horizon),
    stays: await attachLastReminded(db, await stayReminders(db, today, money)),
    documents_expiring: docs.expiring,
    documents_unverified: docs.unverified,
  };
}

// Every bed is a row: occupied by an active guest, booked, out of use
// (maintenance / blocked) or vacant.
async function bedTotals(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM guests g WHERE g.bed_id = b.id AND g.status = 'Active') THEN 1 ELSE 0 END) AS occupied,
       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM guests g WHERE g.bed_id = b.id AND g.status = 'Active')
                 AND EXISTS (SELECT 1 FROM guests g WHERE g.bed_id = b.id AND g.status = 'Booked') THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN b.status != 'Available' AND NOT EXISTS
                 (SELECT 1 FROM guests g WHERE g.bed_id = b.id AND g.status IN ('Active', 'Booked')) THEN 1 ELSE 0 END) AS blocked
     FROM beds b`,
  );
  const total = row.total || 0;
  const occupied = row.occupied || 0;
  const booked = row.booked || 0;
  const blocked = row.blocked || 0;
  return { total, occupied, booked, blocked, vacant: Math.max(total - occupied - booked - blocked, 0) };
}

async function computeDashboard(db, { today = localToday(), horizon = 7, currency = 'INR' } = {}) {
  const count = async (table, where = '') => (await db.get(`SELECT COUNT(*) AS n FROM ${table} ${where}`)).n;
  const sum = async (sql, ...params) => (await db.get(sql, ...params)).s || 0;
  const period = today.slice(0, 7);
  const reminders = await computeReminders(db, { today, horizon, currency });
  const overdueRent = reminders.rent.filter((r) => r.state === 'overdue');

  return {
    today,
    period,
    counts: {
      pgs: await count('pgs'),
      guests: await count('guests', "WHERE status = 'Active'"),
      booked: await count('guests', "WHERE status = 'Booked'"),
      documents: await count('documents'),
      unpaid_bills: await count('bills', "WHERE status = 'Unpaid'"),
    },
    beds: await bedTotals(db),
    rent: {
      expected_this_month: await sum("SELECT COALESCE(SUM(rent), 0) AS s FROM guests WHERE status = 'Active'"),
      collected_this_month: await sum("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE kind = 'Rent' AND period = ?", period),
      overdue_total: Math.round(overdueRent.reduce((s, r) => s + r.outstanding, 0) * 100) / 100,
      overdue_count: overdueRent.length,
    },
    deposits_held: await sum("SELECT COALESCE(SUM(deposit), 0) AS s FROM guests WHERE status = 'Active'"),
    bills_unpaid_total: await sum("SELECT COALESCE(SUM(amount), 0) AS s FROM bills WHERE status = 'Unpaid'"),
    reminders,
  };
}

module.exports = { computeReminders, computeDashboard, localToday, addDays, addMonths, dueDateFor };
