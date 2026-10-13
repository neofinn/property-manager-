'use strict';

(() => {
  const state = { config: null, optionsCache: {}, view: null, query: {} };
  const $ = (sel, root = document) => root.querySelector(sel);

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: '◧' },
    { id: 'reminders', label: 'Reminders', icon: '⏰' },
    { id: 'properties', icon: '⌂' },
    { id: 'tenants', icon: '☺' },
    { id: 'agreements', icon: '✎' },
    { id: 'rent_payments', icon: '₹' },
    { id: 'bills', icon: '≣' },
    { id: 'documents', icon: '❏' },
    { id: 'contacts', icon: '☎' },
    { id: 'schedules', icon: '◷' },
  ];

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
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
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
      <section class="stats">
        ${stat('Properties', d.counts.properties, `${d.occupancy.occupied} occupied · ${d.occupancy.total - d.occupancy.occupied} vacant`, '#/properties')}
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

  // ---------- resource lists ----------

  async function renderList(main, name, query) {
    const def = resource(name);
    const listFields = def.fields.filter((f) => f.list);
    const filterFields = def.fields.filter((f) => f.type === 'select' && f.options.length <= 12);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== '' && k !== 'id') params.set(k, v);
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
          <thead><tr>${listFields.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th class="actions-col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr data-id="${row.id}">
                ${listFields.map((f) => `<td data-label="${esc(f.label)}">${formatCell(f, row)}</td>`).join('')}
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

    if (query.id) {
      const row = rows.find((r) => String(r.id) === query.id) || (await api(`${name}/${query.id}`).catch(() => null));
      if (row) openForm(name, row);
    }
  }

  function rowActions(name, row) {
    const extra = [];
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
        return `<div class="field">${label}<select id="${id}" name="${field.name}"${req}><option value="">—</option>${opts.map((o) => `<option value="${o.id}" ${String(o.id) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
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
        return `<div class="field">${label}<input id="${id}" name="${field.name}" type="${types[field.type] || 'text'}" value="${esc(v)}" ${attrs.join(' ')}${req}></div>`;
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
    const dialog = $('#dialog');
    if (!dialog.open) dialog.showModal();
    const first = $('#form-fields input:not([type=checkbox]), #form-fields select, #form-fields textarea');
    if (first) first.focus();
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
      delete state.optionsCache[name];
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
    // Drop ?id= from the URL so the record doesn't reopen on refresh.
    const { view, query } = parseHash();
    if (query.id) {
      delete query.id;
      const qs = new URLSearchParams(query).toString();
      history.replaceState(null, '', `#/${view}${qs ? `?${qs}` : ''}`);
    }
  }

  // ---------- actions ----------

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

    if (action === 'new') return openForm(name);
    if (action === 'edit') return openForm(name, await api(`${name}/${id}`));
    if (action === 'delete') {
      if (!confirm(`Delete this ${resource(name).singular.toLowerCase()}? This cannot be undone.`)) return;
      try {
        await api(`${name}/${id}`, { method: 'DELETE' });
        delete state.optionsCache[name];
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
        prompt('Copy the reminder text:', el.dataset.text);
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
  $('#dialog').addEventListener('cancel', () => closeDialog());
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  window.addEventListener('hashchange', route);

  api('config')
    .then((config) => {
      state.config = config;
      route();
    })
    .catch((err) => {
      $('#main').innerHTML = `<p class="form-error">Could not load the app: ${esc(err.message)}</p>`;
    });
})();
