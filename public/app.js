'use strict';

(() => {
  const state = { config: null, optionsCache: {}, view: null, query: {} };
  const $ = (sel, root = document) => root.querySelector(sel);
  // The claude.ai demo runs both pages in one document and swaps between them.
  const go = (path) => (window.PM_NAVIGATE ? window.PM_NAVIGATE(path) : location.replace(path));

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: '◧' },
    { id: 'reminders', label: 'Reminders', icon: '⏰' },
    { id: 'properties', icon: '⌂' },
    { id: 'bedboard', label: 'Bed board', icon: '▦' },
    { id: 'rooms', icon: '⊞' },
    { id: 'beds', icon: '⌸' },
    { id: 'tenants', icon: '☺' },
    { id: 'agreements', icon: '✎' },
    { id: 'rent_payments', icon: '₹' },
    { id: 'bills', icon: '≣' },
    { id: 'documents', icon: '❏' },
    { id: 'contacts', icon: '☎' },
    { id: 'schedules', icon: '◷' },
  ];

  const SHARED_TYPES = ['PG / Hostel', 'BnB'];

  // Read-only columns the server computes, shown after the regular list columns.
  const COMPUTED_COLUMNS = {
    properties: [{
      label: 'Rooms / beds',
      render: (r) => (r.room_count ? `${r.room_count} room${r.room_count === 1 ? '' : 's'}${r.bed_count ? ` · ${occupancyText(r.occupied_beds, r.bed_count)}` : ''}` : '<span class="muted">—</span>'),
    }],
    rooms: [{ label: 'Occupancy', render: (r) => (r.bed_count ? occupancyText(r.occupied_beds, r.bed_count) : `${r.tenant_count} tenant${r.tenant_count === 1 ? '' : 's'}`) }],
    beds: [{
      label: 'Occupant',
      render: (r) => (r.occupant ? `<a href="#/tenants?id=${r.occupant_id}">${esc(r.occupant)}</a>` : '<span class="pill good">Vacant</span>'),
    }],
  };

  function occupancyText(occupied, total) {
    const free = total - occupied;
    return `${occupied}/${total} beds filled${free ? ` · <strong>${free} free</strong>` : ''}`;
  }

  // ---------- helpers ----------

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  let moneyFmt;
  function money(n) {
    if (n === null || n === undefined || n === '') return '';
    if (!moneyFmt) {
      try {
        moneyFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: state.config.currency, maximumFractionDigits: 2 });
      } catch {
        moneyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
      }
    }
    return moneyFmt.format(n);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(s) {
    if (!s) return '';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fmtMonth(s) {
    if (!s) return '';
    const [y, m] = s.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function ago(sqlUtc) {
    const d = new Date(`${sqlUtc.replace(' ', 'T')}Z`);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (el.hidden = true), 3500);
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api/${path}`, {
      method: options.method || 'GET',
      headers: { 'X-Requested-With': 'fetch', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401) {
      go('/login');
      throw new Error('Please log in');
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.details = data && data.details;
      throw err;
    }
    return data;
  }

  function resource(name) {
    return state.config.resources[name];
  }

  async function options(refName, force = false) {
    if (force || !state.optionsCache[refName]) state.optionsCache[refName] = await api(`${refName}/options`);
    return state.optionsCache[refName];
  }

  function formatCell(field, row) {
    const v = row[field.name];
    switch (field.type) {
      case 'ref':
        return v ? `<a href="#/${field.ref}?id=${v}">${esc(row[`${field.name}_label`] || `#${v}`)}</a>` : '';
      case 'money':
        return esc(money(v));
      case 'date':
        return esc(fmtDate(v));
      case 'datetime':
        return esc(fmtDateTime(v));
      case 'month':
        return esc(fmtMonth(v));
      case 'bool':
        return v ? '<span class="pill good">✔ Yes</span>' : '<span class="pill muted">No</span>';
      case 'email':
        return v ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : '';
      case 'phone':
        return v ? `<a href="tel:${esc(v)}">${esc(v)}</a>` : '';
      case 'file':
        return row[`${field.name}_url`]
          ? `<a href="${esc(row[`${field.name}_url`])}" target="_blank" rel="noopener">${esc(row[`${field.name}_name`])}</a> <span class="muted">${fmtSize(row[`${field.name}_size`])}</span>`
          : '<span class="muted">—</span>';
      case 'select':
        return v ? `<span class="pill ${pillClass(v)}">${esc(v)}</span>` : '';
      default:
        return esc(v);
    }
  }

  function pillClass(v) {
    if (['Active', 'Occupied', 'Paid', 'Done'].includes(v)) return 'good';
    if (['Unpaid', 'Expired', 'Terminated', 'Cancelled', 'Under Maintenance'].includes(v)) return 'bad';
    if (['Vacant', 'Draft', 'Prospective', 'Scheduled'].includes(v)) return 'warn';
    return '';
  }

  // ---------- navigation ----------

  function renderNav() {
    const current = state.view;
    $('#sidebar').innerHTML = NAV.map((item) => {
      const label = item.label || resource(item.id).label;
      return `<a href="#/${item.id}" class="${current === item.id ? 'active' : ''}"><span class="nav-icon" aria-hidden="true">${item.icon}</span>${esc(label)}</a>`;
    }).join('');
  }

  function parseHash() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    return { view: path || 'dashboard', query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  async function route() {
    const { view, query } = parseHash();
    state.view = view;
    state.query = query;
    renderNav();
    document.body.classList.remove('nav-open');
    const main = $('#main');
    main.innerHTML = '<p class="loading">Loading…</p>';
    try {
      if (view === 'dashboard') await renderDashboard(main);
      else if (view === 'reminders') await renderReminders(main);
      else if (view === 'bedboard') await renderBedBoard(main, query);
      else if (state.config.resources[view]) await renderList(main, view, query);
      else main.innerHTML = '<p>Page not found.</p>';
    } catch (err) {
      main.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }

  // ---------- dashboard & reminders ----------

  function stat(label, value, sub, href) {
    return `<a class="stat" href="${href}"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span>${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</a>`;
  }

  async function renderDashboard(main) {
    const d = await api('dashboard');
    const r = d.rent;
    const pct = r.expected_this_month ? Math.round((r.collected_this_month / r.expected_this_month) * 100) : 0;
    main.innerHTML = `
      <div class="page-head"><h2>Dashboard</h2><span class="muted">${esc(fmtDate(d.today))}</span></div>
      ${d.counts.properties === 0 ? `
        <section class="card welcome">
          <h3>Welcome, ${esc(state.config.company.manager_name)}!</h3>
          <p>Start by adding your first property, or load sample data to explore every feature (an apartment, a villa, a PG with rooms and beds, and a BnB). You can delete the sample records later.</p>
          <div class="head-actions">
            <a class="btn primary" href="#/properties?new=1">+ Add property</a>
            <button class="btn" data-action="load-sample">Load sample data</button>
          </div>
        </section>` : ''}
      <section class="stats">
        ${stat('Properties', d.counts.properties, `${d.occupancy.occupied} occupied · ${d.occupancy.total - d.occupancy.occupied} vacant`, '#/properties')}
        ${d.beds.total ? stat('PG / hostel beds', `${d.beds.occupied}/${d.beds.total}`, `${d.beds.total - d.beds.occupied} vacant · ${d.beds.rooms} rooms`, '#/bedboard') : ''}
        ${stat('Active tenants', d.counts.tenants, `${d.counts.agreements} active agreements`, '#/tenants')}
        ${stat(`Rent collected (${fmtMonth(d.period)})`, money(r.collected_this_month), `of ${money(r.expected_this_month)} expected · ${pct}%`, '#/rent_payments')}
        ${stat('Overdue rent', money(r.overdue_total), `${r.overdue_count} payment${r.overdue_count === 1 ? '' : 's'} pending`, '#/reminders')}
        ${stat('Unpaid bills', money(d.bills_unpaid_total), `${d.counts.unpaid_bills} bill${d.counts.unpaid_bills === 1 ? '' : 's'}`, '#/bills?status=Unpaid')}
        ${stat('Documents', d.counts.documents, `${d.reminders.documents_unverified.length} awaiting verification`, '#/documents')}
      </section>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Rent collected this month"><span class="bar" data-pct="${Math.min(pct, 100)}"></span></div>
      ${reminderSections(d.reminders)}
    `;
    main.querySelectorAll('.bar').forEach((el) => (el.style.width = `${el.dataset.pct}%`));
  }

  async function renderReminders(main) {
    const days = Number(state.query.days) || 7;
    const rem = await api(`reminders?days=${days}`);
    main.innerHTML = `
      <div class="page-head">
        <h2>Reminders</h2>
        <label class="inline">Look ahead
          <select id="horizon">${[0, 3, 7, 14, 30, 60].map((n) => `<option value="${n}" ${n === days ? 'selected' : ''}>${n === 0 ? 'Today only' : `${n} days`}</option>`).join('')}</select>
        </label>
      </div>
      ${reminderSections(rem, true)}
    `;
    $('#horizon').addEventListener('change', (e) => (location.hash = `#/reminders?days=${e.target.value}`));
  }

  function stateBadge(s, extra = '') {
    const labels = { overdue: 'Overdue', due_today: 'Due today', upcoming: 'Upcoming', expired: 'Expired', expiring: 'Expiring', missed: 'Missed', today: 'Today', pending: 'Unverified' };
    const cls = { overdue: 'bad', due_today: 'warn', upcoming: '', expired: 'bad', expiring: 'warn', missed: 'bad', today: 'warn', pending: 'warn' };
    return `<span class="pill ${cls[s] || ''}">${labels[s] || s}${extra ? ` · ${esc(extra)}` : ''}</span>`;
  }

  function sendButtons(item) {
    const parts = [];
    if (item.links.whatsapp) parts.push(`<a class="btn small" target="_blank" rel="noopener" href="${esc(item.links.whatsapp)}" data-log="${esc(item.key)}" data-channel="whatsapp">WhatsApp</a>`);
    if (item.links.sms) parts.push(`<a class="btn small" href="${esc(item.links.sms)}" data-log="${esc(item.key)}" data-channel="sms">SMS</a>`);
    if (item.links.email) parts.push(`<a class="btn small" href="${esc(item.links.email)}" data-log="${esc(item.key)}" data-channel="email">Email</a>`);
    parts.push(`<button class="btn small" data-action="copy" data-text="${esc(item.message)}" data-log="${esc(item.key)}" data-channel="manual">Copy text</button>`);
    return parts.join('');
  }

  function lastReminded(item) {
    return item.last_reminded ? `<span class="muted small">Reminded ${ago(item.last_reminded.sent_at)} via ${esc(item.last_reminded.channel)}</span>` : '';
  }

  function section(title, items, render, empty) {
    return `<section class="card"><h3>${esc(title)} <span class="count">${items.length}</span></h3>${
      items.length ? `<ul class="rem-list">${items.map(render).join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`
    }</section>`;
  }

  function reminderSections(rem, full = false) {
    const rent = section('Rent reminders', rem.rent, (i) => `
      <li>
        <div class="rem-main">
          <strong>${esc(i.tenant_name)}</strong> · ${esc(i.property_name)}
          <div>${stateBadge(i.state, i.state === 'overdue' ? `${i.days_overdue}d` : '')}
            ${esc(fmtMonth(i.period))} rent <strong>${esc(money(i.outstanding))}</strong>
            ${i.paid ? `<span class="muted">(paid ${esc(money(i.paid))} of ${esc(money(i.rent))})</span>` : ''}
            · due ${esc(fmtDate(i.due_date))}</div>
          ${lastReminded(i)}
        </div>
        <div class="rem-actions">
          ${sendButtons(i)}
          <button class="btn small primary" data-action="record-payment" data-agreement="${i.agreement_id}" data-period="${esc(i.period)}" data-amount="${i.outstanding}">Record payment</button>
        </div>
      </li>`, 'No rent due. 🎉');

    const bills = section('Bills due', rem.bills, (b) => `
      <li>
        <div class="rem-main">
          <strong>${esc(b.category)}</strong>${b.provider ? ` (${esc(b.provider)})` : ''} · ${esc(b.property_name)}
          <div>${stateBadge(b.state, b.state === 'overdue' ? `${b.days_overdue}d` : '')} <strong>${esc(money(b.amount))}</strong> · due ${esc(fmtDate(b.due_date))} · paid by ${esc(b.payer || 'Owner')}</div>
        </div>
        <div class="rem-actions"><button class="btn small primary" data-action="bill-paid" data-id="${b.bill_id}">Mark paid</button></div>
      </li>`, 'No bills due.');

    const schedules = section('Upcoming timings & visits', rem.schedules, (s) => `
      <li>
        <div class="rem-main">
          <strong>${esc(s.title)}</strong> ${s.kind ? `<span class="muted">${esc(s.kind)}</span>` : ''}
          <div>${stateBadge(s.state)} ${esc(fmtDateTime(s.starts_at))}${s.ends_at ? ` – ${esc(fmtDateTime(s.ends_at))}` : ''}</div>
          <div class="muted small">${[s.property_name, s.tenant_name, s.contact_name && `${s.contact_name}${s.contact_phone ? ` (${s.contact_phone})` : ''}`].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div class="rem-actions">
          ${s.contact_phone ? `<a class="btn small" href="tel:${esc(s.contact_phone)}">Call</a>` : ''}
          <button class="btn small primary" data-action="schedule-done" data-id="${s.schedule_id}">Done</button>
        </div>
      </li>`, 'Nothing scheduled.');

    const agreements = section('Agreements expiring (60 days)', rem.agreements, (a) => `
      <li>
        <div class="rem-main">
          <strong>${esc(a.tenant_name)}</strong> · ${esc(a.property_name)}
          <div>${stateBadge(a.state)} ends ${esc(fmtDate(a.end_date))} ${a.days_left >= 0 ? `(${a.days_left} days left)` : ''}</div>
          ${lastReminded(a)}
        </div>
        <div class="rem-actions">${sendButtons(a)}<a class="btn small" href="#/agreements?id=${a.agreement_id}">Open</a></div>
      </li>`, 'No agreements expiring soon.');

    const docs = section('Documents', [...rem.documents_expiring, ...rem.documents_unverified], (d) => `
      <li>
        <div class="rem-main">
          <strong>${esc(d.title)}</strong> ${d.doc_type ? `<span class="muted">${esc(d.doc_type)}</span>` : ''}${d.related ? ` · ${esc(d.related)}` : ''}
          <div>${d.type === 'document_expiry' ? `${stateBadge(d.state)} expires ${esc(fmtDate(d.expires_on))}` : stateBadge('pending')}</div>
        </div>
        <div class="rem-actions">
          ${d.type === 'document_unverified' ? `<button class="btn small primary" data-action="doc-verify" data-id="${d.document_id}">Mark verified</button>` : ''}
          <a class="btn small" href="#/documents?id=${d.document_id}">Open</a>
        </div>
      </li>`, 'All documents verified and current.');

    return `<div class="${full ? 'rem-grid full' : 'rem-grid'}">${rent}${bills}${schedules}${agreements}${docs}</div>`;
  }

  // ---------- PG bed board ----------

  async function renderBedBoard(main, query) {
    const [properties, rooms, beds] = await Promise.all([api('properties?sort=name&dir=asc'), api('rooms?sort=room_number&dir=asc&limit=5000'), api('beds?sort=bed_label&dir=asc&limit=5000')]);
    const shared = properties.filter((p) => SHARED_TYPES.includes(p.type) || p.room_count);
    const shown = query.property_id ? shared.filter((p) => String(p.id) === query.property_id) : shared;

    const bedChip = (b, room, property) => {
      if (b.occupant) return `<a class="bed occupied" href="#/tenants?id=${b.occupant_id}" title="${esc(b.bed_label)}: ${esc(b.occupant)}"><span class="bed-name">${esc(b.bed_label)}</span><span>${esc(b.occupant)}</span></a>`;
      if (b.status !== 'Available') return `<a class="bed blocked" href="#/beds?id=${b.id}"><span class="bed-name">${esc(b.bed_label)}</span><span>${esc(b.status)}</span></a>`;
      return `<button class="bed vacant" data-action="assign-bed" data-bed="${b.id}" title="Add a tenant to this bed"><span class="bed-name">${esc(b.bed_label)}</span><span>Vacant${b.monthly_rent ? ` · ${esc(money(b.monthly_rent))}` : ''}</span></button>`;
    };

    main.innerHTML = `
      <div class="page-head">
        <h2>Bed board</h2>
        <div class="head-actions">
          <select id="board-property" aria-label="Property">
            <option value="">All PG / hostel / BnB properties</option>
            ${shared.map((p) => `<option value="${p.id}" ${String(p.id) === query.property_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="legend"><span class="bed-dot vacant"></span> Vacant <span class="bed-dot occupied"></span> Occupied <span class="bed-dot blocked"></span> Reserved / maintenance</p>
      ${shown.length ? shown.map((p) => {
        const pRooms = rooms.filter((r) => r.property_id === p.id);
        return `
          <section class="card board">
            <div class="page-head">
              <h3>${esc(p.name)} <span class="pill">${esc(p.type || '')}</span>${p.pg_for ? ` <span class="pill">${esc(p.pg_for)}</span>` : ''}${p.meals && p.meals !== 'No food' ? ` <span class="pill">🍽 ${esc(p.meals)}</span>` : ''}</h3>
              <div class="head-actions">
                <span class="muted">${p.bed_count ? occupancyText(p.occupied_beds, p.bed_count) : 'No beds yet'}</span>
                <a class="btn small primary" href="#/rooms?property_id=${p.id}">Manage rooms</a>
              </div>
            </div>
            ${p.gate_timings || p.visiting_hours || p.warden_contact_id ? `<p class="muted small board-info">${[p.gate_timings && `🕙 ${esc(p.gate_timings)}`, p.visiting_hours && `Visitors ${esc(p.visiting_hours)}`, p.warden_contact_id && `Warden: ${esc(p.warden_contact_id_label)}`].filter(Boolean).join(' · ')}</p>` : ''}
            ${pRooms.length ? `<div class="rooms">${pRooms.map((r) => {
              const rBeds = beds.filter((b) => b.room_id === r.id);
              const tags = [r.sharing && (['Single', 'Double', 'Triple', 'Four', 'Five+'].includes(r.sharing) ? `${r.sharing} sharing` : r.sharing), r.ac ? 'AC' : '', r.attached_bath ? 'Attached bath' : '', r.floor && `Floor ${r.floor}`].filter(Boolean);
              return `
                <div class="room ${r.status !== 'Available' ? 'room-off' : ''}">
                  <div class="room-head"><a href="#/rooms?id=${r.id}"><strong>Room ${esc(r.room_number)}</strong></a> <span class="muted small">${esc(tags.join(' · '))}</span></div>
                  ${r.status !== 'Available' ? `<span class="pill bad">${esc(r.status)}</span>` : ''}
                  <div class="beds">${rBeds.length ? rBeds.map((b) => bedChip(b, r, p)).join('') : `<span class="muted small">No beds · ${r.tenant_count} tenant${r.tenant_count === 1 ? '' : 's'}</span>`}</div>
                </div>`;
            }).join('')}</div>` : `<p class="muted">No rooms added yet. <a href="#/rooms?property_id=${p.id}">Add rooms</a> to track beds.</p>`}
          </section>`;
      }).join('') : `<div class="empty card"><p>No PG, hostel or BnB properties yet. Add a property with type <strong>PG / Hostel</strong> or <strong>BnB</strong>, then add its rooms.</p><a class="btn primary" href="#/properties">Go to properties</a></div>`}
    `;
    $('#board-property').addEventListener('change', (e) => (location.hash = `#/bedboard${e.target.value ? `?property_id=${e.target.value}` : ''}`));
  }

  // ---------- resource lists ----------

  async function renderList(main, name, query) {
    const def = resource(name);
    const listFields = def.fields.filter((f) => f.list);
    const computed = COMPUTED_COLUMNS[name] || [];
    const filterFields = def.fields.filter((f) => f.type === 'select' && f.options.length <= 12);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== '' && k !== 'id' && k !== 'new') params.set(k, v);
    const rows = await api(`${name}?${params}`);

    main.innerHTML = `
      <div class="page-head">
        <h2>${esc(def.label)}</h2>
        <div class="head-actions">
          <a class="btn" href="/api/${name}/export.csv?${params}" download>Export CSV</a>
          <button class="btn primary" data-action="new">+ Add ${esc(def.singular.toLowerCase())}</button>
        </div>
      </div>
      <form class="toolbar" id="filters">
        <input type="search" name="q" placeholder="Search ${esc(def.label.toLowerCase())}…" value="${esc(query.q || '')}" aria-label="Search">
        ${filterFields.map((f) => `
          <select name="${f.name}" aria-label="${esc(f.label)}">
            <option value="">All ${esc(f.label.toLowerCase())}</option>
            ${f.options.map((o) => `<option ${query[f.name] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select>`).join('')}
        ${Object.keys(query).some((k) => k.endsWith('_id')) ? '<a class="btn small" href="#/' + name + '">Clear filter</a>' : ''}
      </form>
      ${rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr>${listFields.map((f) => `<th>${esc(f.label)}</th>`).join('')}${computed.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th class="actions-col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr data-id="${row.id}">
                ${listFields.map((f) => `<td data-label="${esc(f.label)}">${formatCell(f, row)}</td>`).join('')}
                ${computed.map((c) => `<td data-label="${esc(c.label)}">${c.render(row)}</td>`).join('')}
                <td class="actions-col">${rowActions(name, row)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div class="empty card"><p>No ${esc(def.label.toLowerCase())} yet.</p><button class="btn primary" data-action="new">+ Add ${esc(def.singular.toLowerCase())}</button></div>`}
    `;

    const filters = $('#filters');
    let timer;
    const apply = () => {
      const fd = new FormData(filters);
      const next = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (k.endsWith('_id')) next.set(k, v);
      for (const [k, v] of fd) if (v) next.set(k, v);
      location.hash = `#/${name}${next.toString() ? `?${next}` : ''}`;
    };
    filters.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(apply, e.target.type === 'search' ? 350 : 0);
    });
    filters.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    const search = filters.querySelector('input[type=search]');
    if (query.q) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }

    if (query.new) openForm(name);
    if (query.id) {
      const row = rows.find((r) => String(r.id) === query.id) || (await api(`${name}/${query.id}`).catch(() => null));
      if (row) openForm(name, row);
    }
  }

  function rowActions(name, row) {
    const extra = [];
    if (name === 'properties' && (SHARED_TYPES.includes(row.type) || row.room_count)) {
      extra.push(`<a class="btn small" href="#/bedboard?property_id=${row.id}">Bed board</a>`);
      extra.push(`<a class="btn small" href="#/rooms?property_id=${row.id}">Rooms</a>`);
    }
    if (name === 'rooms') extra.push(`<a class="btn small" href="#/beds?room_id=${row.id}">Beds</a>`);
    if (name === 'beds' && !row.occupant && row.status === 'Available') {
      extra.push(`<button class="btn small" data-action="assign-bed" data-bed="${row.id}">+ Tenant</button>`);
    }
    if (name === 'properties') {
      extra.push(`<a class="btn small" href="#/tenants?property_id=${row.id}">Tenants</a>`);
      extra.push(`<a class="btn small" href="#/bills?property_id=${row.id}">Bills</a>`);
      extra.push(`<a class="btn small" href="#/documents?property_id=${row.id}">Docs</a>`);
    }
    if (name === 'tenants') {
      extra.push(`<a class="btn small" href="#/agreements?tenant_id=${row.id}">Agreements</a>`);
      extra.push(`<a class="btn small" href="#/documents?tenant_id=${row.id}">Docs</a>`);
    }
    if (name === 'agreements') {
      extra.push(`<a class="btn small" href="#/rent_payments?agreement_id=${row.id}">Payments</a>`);
      extra.push(`<button class="btn small" data-action="record-payment" data-agreement="${row.id}" data-amount="${row.monthly_rent}">+ Payment</button>`);
    }
    if (name === 'bills' && row.status !== 'Paid') extra.push(`<button class="btn small" data-action="bill-paid" data-id="${row.id}">Mark paid</button>`);
    if (name === 'documents' && !row.verified) extra.push(`<button class="btn small" data-action="doc-verify" data-id="${row.id}">Verify</button>`);
    if (name === 'schedules' && row.status === 'Scheduled') extra.push(`<button class="btn small" data-action="schedule-done" data-id="${row.id}">Done</button>`);
    return `<div class="row-actions">${extra.join('')}<button class="btn small" data-action="edit" data-id="${row.id}">Edit</button><button class="btn small danger" data-action="delete" data-id="${row.id}" aria-label="Delete">Delete</button></div>`;
  }

  // ---------- forms ----------

  let formContext = null;

  async function fieldInput(field, value) {
    const id = `f-${field.name}`;
    const req = field.required ? ' required' : '';
    const label = `<label for="${id}">${esc(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</label>`;
    const v = value ?? '';
    switch (field.type) {
      case 'textarea':
        return `<div class="field wide">${label}<textarea id="${id}" name="${field.name}" rows="3"${req}>${esc(v)}</textarea></div>`;
      case 'select':
        return `<div class="field">${label}<select id="${id}" name="${field.name}"${req}><option value="">—</option>${field.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
      case 'ref': {
        const opts = await options(field.ref);
        const dep = field.dependsOn ? ` data-depends-on="${field.dependsOn}" data-ref="${field.ref}" data-value="${esc(v)}"` : '';
        return `<div class="field">${label}<select id="${id}" name="${field.name}"${dep}${req}><option value="">—</option>${opts.map((o) => `<option value="${o.id}" ${String(o.id) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
      }
      case 'bool':
        return `<div class="field check"><label><input type="checkbox" id="${id}" name="${field.name}" ${v ? 'checked' : ''}> ${esc(field.label)}</label></div>`;
      case 'file': {
        const current = value && value.url ? `<div class="small">Current: <a href="${esc(value.url)}" target="_blank" rel="noopener">${esc(value.name)}</a> <label class="inline small"><input type="checkbox" name="${field.name}__remove"> remove</label></div>` : '';
        return `<div class="field wide">${label}<input type="file" id="${id}" name="${field.name}" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt">${current}<span class="hint">Max 10 MB · images and PDFs open in the browser</span></div>`;
      }
      default: {
        const types = { number: 'number', money: 'number', date: 'date', datetime: 'datetime-local', month: 'month', email: 'email', phone: 'tel' };
        const attrs = [];
        if (field.type === 'money') attrs.push('step="0.01"');
        if (field.min !== undefined) attrs.push(`min="${field.min}"`);
        if (field.max !== undefined) attrs.push(`max="${field.max}"`);
        if (field.placeholder) attrs.push(`placeholder="${esc(field.placeholder)}"`);
        const hint = field.hint ? `<span class="hint">${esc(field.hint)}</span>` : '';
        return `<div class="field">${label}<input id="${id}" name="${field.name}" type="${types[field.type] || 'text'}" value="${esc(v)}" ${attrs.join(' ')}${req}>${hint}</div>`;
      }
    }
  }

  async function openForm(name, row = null, preset = {}) {
    const def = resource(name);
    formContext = { name, id: row ? row.id : null };
    $('#dialog-title').textContent = row ? `Edit ${def.singular.toLowerCase()}` : `New ${def.singular.toLowerCase()}`;
    $('#form-error').hidden = true;
    const values = row || { ...Object.fromEntries(def.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default])), ...preset };
    const inputs = [];
    for (const f of def.fields) {
      const v = f.type === 'file' ? (row && row[`${f.name}_url`] ? { url: row[`${f.name}_url`], name: row[`${f.name}_name`] } : null) : values[f.name];
      inputs.push(await fieldInput(f, v));
    }
    $('#form-fields').innerHTML = inputs.join('');
    wireDependentSelects(name);
    const dialog = $('#dialog');
    if (!dialog.open) dialog.showModal();
    const first = $('#form-fields input:not([type=checkbox]), #form-fields select, #form-fields textarea');
    if (first) first.focus();
  }

  // Room and bed dropdowns only list rooms of the chosen property and beds of
  // the chosen room, and are hidden when there is nothing to choose.
  function wireDependentSelects(resourceName) {
    const form = $('#record-form');
    const children = [...form.querySelectorAll('select[data-depends-on]')];
    if (!children.length) return;

    const refresh = () => {
      for (const select of children) {
        const parentValue = form.elements[select.dataset.dependsOn]?.value || '';
        const keep = select.value || select.dataset.value || '';
        const opts = (state.optionsCache[select.dataset.ref] || []).filter((o) => parentValue && String(o.parent) === parentValue);
        select.innerHTML = '<option value="">—</option>' + opts.map((o) => {
          const occupied = o.occupant ? ` – ${o.occupant}` : select.dataset.ref === 'beds' ? (o.status === 'Available' ? ' – vacant' : ` – ${o.status}`) : '';
          return `<option value="${o.id}" ${String(o.id) === keep ? 'selected' : ''}>${esc((o.short_label || o.label) + occupied)}</option>`;
        }).join('');
        select.dataset.value = '';
        select.closest('.field').hidden = opts.length === 0;
      }
    };

    for (const select of children) {
      const parent = form.elements[select.dataset.dependsOn];
      parent?.addEventListener('change', () => {
        for (const c of children) c.dataset.value = '';
        refresh();
      });
    }

    if (resourceName === 'agreements') {
      // Suggest the bed or room rent when the rent box is still empty.
      const rent = form.elements.monthly_rent;
      const suggest = () => {
        if (!rent || rent.value) return;
        const bed = (state.optionsCache.beds || []).find((o) => String(o.id) === form.elements.bed_id.value);
        const room = (state.optionsCache.rooms || []).find((o) => String(o.id) === form.elements.room_id.value);
        const value = bed ? bed.monthly_rent ?? bed.room_rent_per_bed : room ? room.rent_per_room ?? room.rent_per_bed : null;
        if (value !== null && value !== undefined) rent.value = value;
      };
      form.elements.bed_id?.addEventListener('change', suggest);
      form.elements.room_id?.addEventListener('change', suggest);
    }
    refresh();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).split(',')[1] || '' });
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  async function submitForm(e) {
    e.preventDefault();
    if (!formContext) return;
    const { name, id } = formContext;
    const def = resource(name);
    const form = $('#record-form');
    const body = {};
    for (const f of def.fields) {
      const input = form.elements[f.name];
      if (!input) continue;
      if (f.type === 'bool') body[f.name] = input.checked;
      else if (f.type === 'file') {
        if (input.files[0]) {
          if (input.files[0].size > 10 * 1024 * 1024) return showFormError('File must be under 10 MB');
          body[f.name] = await readFile(input.files[0]);
        } else if (form.elements[`${f.name}__remove`]?.checked) body[f.name] = null;
      } else body[f.name] = input.value === '' ? null : input.value;
    }
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      await api(id ? `${name}/${id}` : name, { method: id ? 'PATCH' : 'POST', body });
      state.optionsCache = {};
      closeDialog();
      toast(`${def.singular} saved`);
      route();
    } catch (err) {
      showFormError(err.message, err.details);
    } finally {
      btn.disabled = false;
    }
  }

  function showFormError(message, details) {
    const el = $('#form-error');
    const list = details ? Object.values(details) : [];
    el.innerHTML = `${esc(message)}${list.length ? `<ul>${list.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
    el.hidden = false;
    for (const field of document.querySelectorAll('#form-fields .field')) field.classList.remove('invalid');
    for (const key of Object.keys(details || {})) $(`#f-${key}`)?.closest('.field')?.classList.add('invalid');
    el.scrollIntoView({ block: 'nearest' });
  }

  function closeDialog() {
    formContext = null;
    const dialog = $('#dialog');
    if (dialog.open) dialog.close();
    // Drop ?id= / ?new= from the URL so the form doesn't reopen on refresh.
    const { view, query } = parseHash();
    if (query.id || query.new) {
      delete query.id;
      delete query.new;
      const qs = new URLSearchParams(query).toString();
      history.replaceState(null, '', `#/${view}${qs ? `?${qs}` : ''}`);
    }
  }

  // ---------- actions ----------

  // In-page yes/no question (browser confirm() popups are blocked in some views).
  function confirmAction(message, actionLabel) {
    const dialog = $('#confirm-dialog');
    $('#confirm-message').textContent = message;
    $('#confirm-ok').textContent = actionLabel;
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  async function quickUpdate(name, id, body, message) {
    try {
      await api(`${name}/${id}`, { method: 'PATCH', body });
      toast(message);
      route();
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.addEventListener('click', async (e) => {
    const logEl = e.target.closest('[data-log]');
    if (logEl) {
      api('reminders/log', { method: 'POST', body: { key: logEl.dataset.log, channel: logEl.dataset.channel } }).catch(() => {});
    }
    if (e.target.closest('[data-close]')) return closeDialog();

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    const name = state.view;

    if (action === 'new') {
      // Pre-fill from the list's filter, e.g. adding a room from a property's room list.
      const preset = {};
      for (const f of resource(name).fields) if (state.query[f.name] && f.type !== 'select') preset[f.name] = state.query[f.name];
      if (el.dataset.preset) Object.assign(preset, JSON.parse(el.dataset.preset));
      return openForm(name, null, preset);
    }
    if (action === 'assign-bed') {
      const beds = await options('beds', true);
      const bed = beds.find((b) => String(b.id) === el.dataset.bed);
      const room = bed && (await options('rooms', true)).find((r) => r.id === bed.parent);
      return openForm('tenants', null, { property_id: room?.parent, room_id: bed?.parent, bed_id: el.dataset.bed, status: 'Active', move_in: today() });
    }
    if (action === 'edit') return openForm(name, await api(`${name}/${id}`));
    if (action === 'delete') {
      if (!(await confirmAction(`Delete this ${resource(name).singular.toLowerCase()}? This cannot be undone.`, 'Delete'))) return;
      try {
        await api(`${name}/${id}`, { method: 'DELETE' });
        state.optionsCache = {};
        toast('Deleted');
        route();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(el.dataset.text);
        toast('Reminder text copied');
      } catch {
        toast('Copying is blocked here. Select the text in the reminder and copy it.', true);
      }
      return;
    }
    if (action === 'record-payment') {
      return openForm('rent_payments', null, {
        agreement_id: el.dataset.agreement,
        period: el.dataset.period || today().slice(0, 7),
        amount: el.dataset.amount,
        paid_on: today(),
      });
    }
    if (action === 'load-sample') {
      el.disabled = true;
      try {
        await api('sample-data', { method: 'POST' });
        state.optionsCache = {};
        toast('Sample data loaded');
        route();
      } catch (err) {
        el.disabled = false;
        toast(err.message, true);
      }
      return;
    }
    if (action === 'bill-paid') return quickUpdate('bills', id, { status: 'Paid', paid_on: today() }, 'Bill marked as paid');
    if (action === 'doc-verify') return quickUpdate('documents', id, { verified: true, verified_on: today() }, 'Document marked as verified');
    if (action === 'schedule-done') return quickUpdate('schedules', id, { status: 'Done' }, 'Marked as done');
  });

  // Open a record when its row is clicked (but not when clicking links/buttons).
  document.addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr[data-id]');
    if (!tr || e.target.closest('a, button')) return;
    api(`${state.view}/${tr.dataset.id}`).then((row) => openForm(state.view, row)).catch((err) => toast(err.message, true));
  });

  $('#record-form').addEventListener('submit', submitForm);

  $('#logout-btn').addEventListener('click', async () => {
    await api('auth/logout', { method: 'POST' }).catch(() => {});
    go('/login');
  });

  const feedbackDialog = $('#feedback-dialog');
  $('#feedback-btn').addEventListener('click', () => feedbackDialog.showModal());
  feedbackDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-feedback]')) feedbackDialog.close();
  });
  $('#feedback-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!form.message.value.trim()) return form.message.focus();
    try {
      await api('feedback', { method: 'POST', body: { message: form.message.value, page: location.hash || '#/dashboard' } });
      form.reset();
      feedbackDialog.close();
      toast('Thank you! Your feedback was sent.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  if ('serviceWorker' in navigator && !window.PM_DEMO) navigator.serviceWorker.register('/sw.js').catch(() => {});
  $('#dialog').addEventListener('cancel', () => closeDialog());
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  window.addEventListener('hashchange', route);

  function start() {
    state.optionsCache = {};
    $('#main').innerHTML = '<p class="loading">Loading…</p>';
    return api('config')
      .then((config) => {
        state.config = config;
        moneyFmt = null;
        $('#account-name').textContent = `${config.company.company_name} · ${config.company.manager_name}`;
        route();
      })
      .catch((err) => {
        $('#main').innerHTML = `<p class="form-error">Could not load the app: ${esc(err.message)}</p>`;
      });
  }

  if (window.PM_DEMO) window.PM_startApp = start;
  else start();
})();
