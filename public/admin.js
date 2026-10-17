'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { analytics: null, feedback: [], settings: null, log: [] };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat('en-IN');

  function when(sqlUtc) {
    if (!sqlUtc) return '—';
    const d = new Date(`${String(sqlUtc).replace(' ', 'T')}Z`);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
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
    const res = await fetch(`/api/admin/${path}`, {
      method: options.method || 'GET',
      headers: { 'X-Requested-With': 'fetch', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') {
      showLogin();
      throw new Error('Please log in again');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // In-page dialog: resolves the typed value (or true) on OK, null on cancel.
  function ask({ title, text, label, okLabel = 'OK', danger = false, type = 'text' }) {
    const dialog = $('#admin-dialog');
    $('#admin-dialog-title').textContent = title;
    $('#admin-dialog-text').textContent = text || '';
    $('#admin-dialog-field').hidden = !label;
    $('#admin-dialog-label').textContent = label || '';
    const input = $('#admin-dialog-input');
    input.value = '';
    input.type = type;
    const ok = $('#admin-dialog-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
    dialog.showModal();
    if (label) input.focus();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? (label ? input.value : true) : null), { once: true });
    });
  }

  // ---------- login ----------

  function showLogin() {
    $('#admin-app').hidden = true;
    $('#admin-login').hidden = false;
    $('#admin-password').focus();
  }

  $('#admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#admin-login-error');
    err.hidden = true;
    try {
      await api('login', { method: 'POST', body: { password: $('#admin-password').value } });
      $('#admin-password').value = '';
      start();
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });

  $('#admin-logout').addEventListener('click', async () => {
    await api('logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------- views ----------

  function tile(label, value, sub) {
    return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span>${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
  }

  // Daily sign-ups, last 30 days: one series, so no legend; hover any day for its count.
  // Drawn at the container's real width so labels stay at their set size.
  function signupChart(days) {
    const W = Math.max(320, Math.round($('#admin-main').clientWidth - 66)); // minus page and card padding
    const H = 180;
    const pad = { top: 12, right: 8, bottom: 26, left: 30 };
    const max = Math.max(1, ...days.map((d) => d.count));
    const step = max <= 4 ? 1 : Math.ceil(max / 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => pad.top + (H - pad.top - pad.bottom) * (1 - v / top);
    const slot = (W - pad.left - pad.right) / days.length;
    const barW = Math.max(2, slot - 2); // 2px surface gap between bars
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);

    const grid = ticks
      .map((v) => `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(v)}" y2="${y(v)}"></line><text class="axis" x="${pad.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
      .join('');
    const bars = days
      .map((d, i) => {
        const x = pad.left + i * slot + 1;
        const h = Math.max(0, y(0) - y(d.count));
        const label = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        const r = Math.min(4, barW / 2, h);
        // Rounded top, square base on the axis.
        const path = h
          ? `M${x},${y(0)} V${y(d.count) + r} Q${x},${y(d.count)} ${x + r},${y(d.count)} H${x + barW - r} Q${x + barW},${y(d.count)} ${x + barW},${y(d.count) + r} V${y(0)} Z`
          : '';
        return `<g class="bar-hit" data-tip="${esc(`${label}: ${d.count} sign-up${d.count === 1 ? '' : 's'}`)}">
          <rect x="${pad.left + i * slot}" y="${pad.top}" width="${slot}" height="${y(0) - pad.top}" fill="transparent"></rect>
          ${path ? `<path class="bar" d="${path}"></path>` : ''}
        </g>`;
      })
      .join('');
    const short = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const first = short(days[0].day);
    const last = short(days.at(-1).day);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="New company sign-ups per day for the last 30 days">
      ${grid}
      <line class="baseline" x1="${pad.left}" x2="${W - pad.right}" y1="${y(0)}" y2="${y(0)}"></line>
      ${bars}
      <text class="axis" x="${pad.left}" y="${H - 6}">${first}</text>
      <text class="axis" x="${W - pad.right}" y="${H - 6}" text-anchor="end">${last}</text>
    </svg>`;
  }

  function renderOverview(main) {
    const a = state.analytics;
    const t = a.totals;
    main.innerHTML = `
      <div class="page-head"><h2>Overview</h2><span class="muted">${esc(a.storage === 'postgres' ? 'Postgres / Supabase' : 'SQLite files')}</span></div>
      <section class="stats">
        ${tile('Companies', num.format(a.companies.total), `${a.companies.new_7d} new this week · ${a.companies.new_30d} this month`)}
        ${tile('Active this week', num.format(a.companies.active_7d), `${a.companies.total ? Math.round((a.companies.active_7d / a.companies.total) * 100) : 0}% of companies`)}
        ${tile('PGs managed', num.format(t.pgs), `${num.format(t.guests)} active guests`)}
        ${tile('Beds', `${num.format(t.occupied_beds)}/${num.format(t.beds)}`, 'occupied / total')}
        ${tile('Rent recorded this month', inr.format(t.rent_collected_this_month), 'across all companies')}
        ${tile('Open feedback', num.format(a.feedback_open), a.companies.suspended ? `${a.companies.suspended} suspended compan${a.companies.suspended === 1 ? 'y' : 'ies'}` : 'no suspended companies')}
      </section>
      <section class="card">
        <h3>Sign-ups, last 30 days</h3>
        <div class="chart-wrap">${signupChart(a.signups)}</div>
        <details class="table-toggle"><summary>Show as table</summary>
          <div class="table-wrap"><table><thead><tr><th>Day</th><th>Sign-ups</th></tr></thead>
          <tbody>${a.signups.filter((d) => d.count).map((d) => `<tr><td>${esc(d.day)}</td><td class="num">${d.count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No sign-ups in this period</td></tr>'}</tbody></table></div>
        </details>
      </section>`;
  }

  function renderCompanies(main) {
    const rows = state.analytics.rows;
    main.innerHTML = `
      <div class="page-head"><h2>Companies</h2><span class="muted">${rows.length} total</span></div>
      ${rows.length ? `<div class="table-wrap"><table class="admin-table">
        <thead><tr><th>Company</th><th>Manager · phone</th><th>Status</th><th class="num">PGs</th><th class="num">Guests</th><th class="num">Beds</th><th>Signed up</th><th>Last active</th><th class="actions-col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows
          .map(
            (c) => `<tr>
            <td data-label="Company"><strong>${esc(c.company_name)}</strong> <span class="muted small">#${c.id}</span></td>
            <td data-label="Manager">${esc(c.manager_name)}<br><span class="muted small">${esc(c.phone)}</span></td>
            <td data-label="Status"><span class="pill ${c.status === 'active' ? 'good' : 'bad'}">${c.status === 'active' ? 'Active' : 'Suspended'}</span></td>
            <td data-label="PGs" class="num">${c.stats?.error ? '!' : num.format(c.stats?.pgs ?? 0)}</td>
            <td data-label="Guests" class="num">${num.format(c.stats?.guests ?? 0)}</td>
            <td data-label="Beds" class="num">${num.format(c.stats?.occupied_beds ?? 0)}/${num.format(c.stats?.beds ?? 0)}</td>
            <td data-label="Signed up">${esc(when(c.created_at))}</td>
            <td data-label="Last active">${esc(when(c.last_active_at))}</td>
            <td class="actions-col"><div class="row-actions">
              <a class="btn small" href="/api/admin/companies/${c.id}/export">Export</a>
              <button class="btn small" data-act="sign-out" data-id="${c.id}">Sign out</button>
              <button class="btn small" data-act="reset" data-id="${c.id}">Reset password</button>
              ${c.status === 'active'
                ? `<button class="btn small" data-act="suspend" data-id="${c.id}">Suspend</button>`
                : `<button class="btn small" data-act="activate" data-id="${c.id}">Reactivate</button>`}
              <button class="btn small danger" data-act="delete" data-id="${c.id}">Delete</button>
            </div></td>
          </tr>`,
          )
          .join('')}</tbody></table></div>` : '<div class="empty card"><p>No companies have signed up yet.</p></div>'}`;
  }

  function renderFeedback(main) {
    const items = state.feedback;
    main.innerHTML = `
      <div class="page-head"><h2>Feedback</h2><span class="muted">${items.filter((f) => !f.resolved).length} open</span></div>
      ${items.length ? `<ul class="rem-list card">${items
        .map(
          (f) => `<li class="${f.resolved ? 'resolved' : ''}">
            <div class="rem-main">
              <div><strong>${esc(f.company_name || 'Deleted company')}</strong> <span class="muted small">${esc(f.manager_name || '')} · ${esc(f.phone || '')} · ${esc(when(f.created_at))} · on ${esc(f.page || '?')}</span></div>
              <p class="feedback-text">${esc(f.message)}</p>
            </div>
            <div class="rem-actions"><button class="btn small" data-act="${f.resolved ? 'reopen' : 'resolve'}" data-id="${f.id}">${f.resolved ? 'Reopen' : 'Mark resolved'}</button></div>
          </li>`,
        )
        .join('')}</ul>` : '<div class="empty card"><p>No feedback yet.</p></div>'}`;
  }

  function renderSettings(main) {
    const s = state.settings;
    main.innerHTML = `
      <div class="page-head"><h2>Controls</h2></div>
      <form class="card admin-settings" id="settings-form" novalidate>
        <label class="switch"><input type="checkbox" id="set-signups" ${s.signups_open === '1' ? 'checked' : ''}> <span><strong>Allow new sign-ups</strong><br><span class="muted small">When off, the sign-up form says sign-ups are closed. Existing companies can still log in.</span></span></label>
        <div class="field">
          <label for="set-invite">Invite code</label>
          <input id="set-invite" value="${esc(s.invite_code)}" placeholder="Leave empty for open sign-up" autocomplete="off">
          <span class="hint">New companies must type this code to sign up. Overrides the BETA_INVITE_CODE setting on the server.</span>
        </div>
        <label class="switch"><input type="checkbox" id="set-readonly" ${s.read_only === '1' ? 'checked' : ''}> <span><strong>Maintenance mode (read-only)</strong><br><span class="muted small">Everyone can still see their data, but nothing can be added or changed. Use it during database work.</span></span></label>
        <div class="field">
          <label for="set-notice">Notice shown to every user</label>
          <input id="set-notice" value="${esc(s.notice)}" maxlength="300" placeholder="e.g. Scheduled maintenance tonight 11 pm – 11:30 pm">
          <span class="hint">Appears as a banner at the top of the app. Leave empty to hide it.</span>
        </div>
        <div><button class="btn primary" type="submit">Save controls</button></div>
      </form>`;
    $('#settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        state.settings = await api('settings', {
          method: 'PATCH',
          body: {
            signups_open: $('#set-signups').checked,
            invite_code: $('#set-invite').value,
            read_only: $('#set-readonly').checked,
            notice: $('#set-notice').value,
          },
        });
        toast('Controls saved');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function renderLog(main) {
    main.innerHTML = `
      <div class="page-head"><h2>Activity log</h2><span class="muted">Last 100 admin actions</span></div>
      ${state.log.length ? `<div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>Action</th><th>Detail</th></tr></thead><tbody>${state.log
        .map((e) => `<tr><td class="num">${esc(e.created_at)}</td><td>${esc(e.action.replace(/_/g, ' '))}</td><td>${esc(e.detail)}</td></tr>`)
        .join('')}</tbody></table></div>` : '<div class="empty card"><p>No admin actions yet.</p></div>'}`;
  }

  const VIEWS = { overview: renderOverview, companies: renderCompanies, feedback: renderFeedback, settings: renderSettings, log: renderLog };

  async function load(view) {
    if (view === 'overview' || view === 'companies') state.analytics = await api('analytics');
    if (view === 'feedback') state.feedback = await api('feedback');
    if (view === 'settings') state.settings = await api('settings');
    if (view === 'log') state.log = await api('log');
  }

  async function route() {
    const view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
    for (const a of document.querySelectorAll('.admin-tabs a')) a.classList.toggle('active', a.getAttribute('href') === `#${view}`);
    const main = $('#admin-main');
    main.innerHTML = '<p class="loading">Loading…</p>';
    try {
      await load(view);
      VIEWS[view](main);
    } catch (err) {
      main.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }

  // ---------- actions ----------

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const { act, id } = el.dataset;
    const company = state.analytics?.rows.find((c) => String(c.id) === id);
    try {
      if (act === 'resolve' || act === 'reopen') {
        await api(`feedback/${id}`, { method: 'PATCH', body: { resolved: act === 'resolve' } });
      } else if (act === 'sign-out') {
        const r = await api(`companies/${id}/sign-out`, { method: 'POST' });
        toast(`Signed out ${r.sessions} session${r.sessions === 1 ? '' : 's'}`);
      } else if (act === 'suspend') {
        if (!(await ask({ title: `Suspend ${company.company_name}?`, text: 'They are signed out at once and cannot log in until you reactivate them. Their data is kept.', okLabel: 'Suspend', danger: true }))) return;
        await api(`companies/${id}/suspend`, { method: 'POST' });
        toast('Company suspended');
      } else if (act === 'activate') {
        await api(`companies/${id}/activate`, { method: 'POST' });
        toast('Company reactivated');
      } else if (act === 'reset') {
        const password = await ask({ title: `New password for ${company.company_name}`, text: 'They are signed out everywhere. Send them the new password yourself.', label: 'New password (at least 8 characters)', okLabel: 'Set password' });
        if (password === null) return;
        await api(`companies/${id}/reset-password`, { method: 'POST', body: { password } });
        toast('Password changed');
      } else if (act === 'delete') {
        const confirm = await ask({
          title: `Delete ${company.company_name}?`,
          text: 'This permanently deletes the company, its login and all of its PGs, beds, guests, payments and documents. Export it first if you may need it.',
          label: `Type ${company.company_name} to confirm`,
          okLabel: 'Delete for good',
          danger: true,
        });
        if (confirm === null) return;
        await api(`companies/${id}`, { method: 'DELETE', body: { confirm } });
        toast('Company deleted');
      } else {
        return;
      }
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Chart tooltip: hover or tap a day.
  const tip = $('#chart-tip');
  document.addEventListener('pointerover', (e) => {
    const bar = e.target.closest('.bar-hit');
    if (!bar) return void (tip.hidden = true);
    tip.textContent = bar.dataset.tip;
    tip.hidden = false;
    const r = bar.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${r.top + window.scrollY - tip.offsetHeight - 6}px`;
  });

  window.addEventListener('hashchange', route);

  async function start() {
    try {
      const me = await api('me');
      $('#storage-badge').textContent = me.storage === 'postgres' ? 'Postgres' : 'SQLite';
      $('#admin-login').hidden = true;
      $('#admin-app').hidden = false;
      route();
    } catch {
      showLogin();
    }
  }

  start();
})();
