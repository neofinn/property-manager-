'use strict';

(() => {
  const errorBox = document.getElementById('auth-error');
  // The claude.ai demo shows this page and the app in one document.
  const go = (path) => (window.PM_NAVIGATE ? window.PM_NAVIGATE(path) : location.replace(path));

  function show(mode) {
    errorBox.hidden = true;
    for (const m of ['login', 'signup']) {
      document.getElementById(`${m}-form`).hidden = m !== mode;
      document.getElementById(`tab-${m}`).classList.toggle('active', m === mode);
      document.getElementById(`tab-${m}`).setAttribute('aria-selected', String(m === mode));
    }
    document.title = `Property Manager – ${mode === 'signup' ? 'Sign up' : 'Log in'}`;
    document.getElementById(`${mode}-form`).querySelector('input').focus();

    if (mode === 'signup') {
      fetch('/api/auth/config')
        .then((r) => r.json())
        .then((cfg) => {
          if (cfg.inviteRequired) {
            document.getElementById('invite-field').hidden = false;
            document.getElementById('signup-invite').required = true;
          }
        })
        .catch(() => {});
    }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function showError(form, message, details = {}) {
    const list = Object.values(details);
    errorBox.innerHTML = `${esc(message)}${list.length ? `<ul>${list.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
    errorBox.hidden = false;
    for (const el of form.querySelectorAll('.field')) el.classList.remove('invalid');
    for (const name of Object.keys(details)) form.elements[name]?.closest('.field')?.classList.add('invalid');
  }

  async function submit(e) {
    e.preventDefault();
    const form = e.target;
    const mode = form.id === 'signup-form' ? 'signup' : 'login';
    errorBox.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    if (mode === 'signup' && data.password !== data.password2) {
      return showError(form, 'Passwords do not match', { password2: 'Re-type the same password' });
    }
    delete data.password2;

    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showError(form, body.error || 'Something went wrong', body.details || {});
      form.reset();
      go('/');
    } catch {
      showError(form, 'Could not reach the server. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById('login-form').addEventListener('submit', submit);
  document.getElementById('signup-form').addEventListener('submit', submit);

  if (window.PM_DEMO) {
    window.PM_showAuth = show;
  } else {
    show(/\/signup(\.html)?$/.test(location.pathname) ? 'signup' : 'login');
    if ('serviceWorker' in navigator && !window.PM_API_BASE) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
