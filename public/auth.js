'use strict';

(() => {
  const mode = location.pathname === '/signup' ? 'signup' : 'login';
  const form = document.getElementById(`${mode}-form`);
  const errorBox = document.getElementById('auth-error');

  form.hidden = false;
  document.getElementById(`tab-${mode}`).classList.add('active');
  document.getElementById(`tab-${mode}`).setAttribute('aria-selected', 'true');
  document.title = `Property Manager – ${mode === 'signup' ? 'Sign up' : 'Log in'}`;
  form.querySelector('input').focus();

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

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function showError(message, details = {}) {
    const list = Object.values(details);
    errorBox.innerHTML = `${esc(message)}${list.length ? `<ul>${list.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
    errorBox.hidden = false;
    for (const el of form.querySelectorAll('.field')) el.classList.remove('invalid');
    for (const name of Object.keys(details)) form.elements[name]?.closest('.field')?.classList.add('invalid');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    if (mode === 'signup' && data.password !== data.password2) {
      return showError('Passwords do not match', { password2: 'Re-type the same password' });
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
      if (!res.ok) return showError(body.error || 'Something went wrong', body.details || {});
      location.replace('/');
    } catch {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
