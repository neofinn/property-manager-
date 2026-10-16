'use strict';

// Hosted mode: the pages are static files (e.g. GitHub Pages) and the API runs
// elsewhere (a Supabase Edge Function). config.js sets window.PM_API_BASE.
// This sends the app's /api requests there with the login token in a header,
// keeps the tokens, maps page links, and turns file links into downloads.
// Loaded before the app's own scripts; does nothing without PM_API_BASE.

(() => {
  const base = window.PM_API_BASE;
  if (!base) return;

  const memory = {};
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key) || '';
      } catch {
        return memory[key] || '';
      }
    },
    set(key, value) {
      memory[key] = value;
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        // storage blocked: the token lasts for this visit
      }
    },
  };

  const isAdmin = (url) => url.startsWith('/api/admin');
  const tokenKey = (url) => (isAdmin(url) ? 'pm-admin-session' : 'pm-session');
  const tokenHeader = (url) => (isAdmin(url) ? 'X-Admin-Session' : 'X-Session');
  const issuesToken = /^\/api\/(auth\/(login|signup|logout)|admin\/(login|logout))$/;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    const headers = new Headers(init.headers || {});
    const token = store.get(tokenKey(url));
    if (token) headers.set(tokenHeader(url), token);
    const res = await realFetch(base + url.slice(4), { ...init, headers });
    if (res.ok && issuesToken.test(url.split('?')[0])) {
      const data = await res.clone().json().catch(() => ({}));
      store.set(tokenKey(url), data.token || '');
    }
    return res;
  };

  // The app asks for '/', '/login' and '/signup'; on static hosting these are files.
  const pages = { '/': './index.html', '/login': './login.html', '/signup': './signup.html' };
  window.PM_NAVIGATE = (path) => location.replace(pages[path] || path);

  // File and CSV links point at /api/...: fetch them with the token and save the file.
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a[href^="/api/"]');
    if (!link) return;
    e.preventDefault();
    const res = await fetch(link.getAttribute('href'));
    if (!res.ok) return;
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const plain = disposition.match(/filename="([^"]+)"/);
    const name = encoded ? decodeURIComponent(encoded[1]) : plain ? plain[1] : 'download';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  });
})();
