'use strict';

// Boots the claude.ai demo: starts SQLite in the page, loads this viewer's
// saved company from the artifact's private per-person storage, answers the
// app's /api requests with the in-page backend, and saves after every change.

const { createBackend, toBase64, fromBase64 } = require('./backend');
const { HttpError } = require('../store');

const CHUNK_CHARS = 180000; // stays well under the 256 KiB document limit
const SAVE_DELAY_MS = 1200;

const $ = (sel) => document.querySelector(sel);

function setStatus(text, tone = '') {
  const el = $('#save-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function showFatal(message) {
  $('#demo-splash').hidden = false;
  $('#demo-splash').innerHTML = `<div class="auth-card"><h1>PG Manager</h1><p class="form-error"></p></div>`;
  $('#demo-splash .form-error').textContent = message;
}

async function useCapability(name) {
  if (!window.claude || typeof window.claude.use !== 'function') return null;
  try {
    return await window.claude.use(name);
  } catch {
    return null;
  }
}

// The company database is saved as base64 chunks under this viewer's private
// data/users/<id>/ subtree. Each save writes a new generation of chunks, then
// switches the pointer document to it, then removes the old generation, so a
// save cut off halfway never leaves a mix of old and new chunks.
function createPersistence(db, uid) {
  const prefix = `data/users/${uid}`;
  const pointer = db.doc(`${prefix}/crm`);
  let current = null;

  return {
    async load() {
      const snap = await pointer.get();
      if (!snap.exists) return null;
      current = snap.data();
      const parts = await Promise.all(
        Array.from({ length: current.chunks }, (_, i) => db.doc(`${prefix}/crm-${current.gen}-${i}`).get()),
      );
      if (parts.some((p) => !p.exists)) throw new Error('Your saved data is incomplete.');
      return fromBase64(parts.map((p) => p.data().data).join(''));
    },
    async save(bytes) {
      const b64 = toBase64(bytes);
      const gen = (current?.gen || 0) + 1;
      const chunks = [];
      for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
      for (let i = 0; i < chunks.length; i++) await db.doc(`${prefix}/crm-${gen}-${i}`).set({ data: chunks[i] });
      const next = { gen, chunks: chunks.length, bytes: bytes.length, saved_at: new Date().toISOString() };
      await pointer.set(next);
      const old = current;
      current = next;
      if (old) for (let i = 0; i < old.chunks; i++) await db.doc(`${prefix}/crm-${old.gen}-${i}`).delete().catch(() => {});
    },
  };
}

function saveErrorMessage(err) {
  if (err?.code === 'quota_exceeded') return 'Storage is full – delete some uploaded documents';
  if (err?.code === 'invalid_argument') return 'View-only access – ask the owner for Contributor access to save';
  if (err?.code === 'revoked') return 'Access changed – reload the page';
  return 'Not saved – check your connection';
}

async function boot() {
  const SQL = await window.initSqlJs({ wasmBinary: fromBase64(window.PM_SQL_WASM) });
  const [db, user] = await Promise.all([useCapability('db'), useCapability('user')]);
  const uid = user ? await user.id().catch(() => null) : null;
  const persistence = db && uid ? createPersistence(db, uid) : null;

  let bytes = null;
  if (persistence) {
    setStatus('Loading your data…');
    try {
      bytes = await persistence.load();
    } catch (err) {
      // Never overwrite saved data we could not read.
      showFatal(`Could not load your saved data (${err.message || err.code}). Reload the page to try again.`);
      return;
    }
  }

  const tokenKey = `pm-demo-token:${uid || 'guest'}`;
  let memoryToken = null;
  const backend = await createBackend({
    SQL,
    bytes,
    currency: 'INR',
    getToken() {
      try {
        return localStorage.getItem(tokenKey) || memoryToken;
      } catch {
        return memoryToken;
      }
    },
    setToken(token) {
      memoryToken = token;
      try {
        if (token) localStorage.setItem(tokenKey, token);
        else localStorage.removeItem(tokenKey);
      } catch {
        // storage blocked: the in-memory token lasts for this visit
      }
    },
    // Beta sign-ups and feedback go to shared paths only the owner can read.
    async onSignup(company) {
      if (!db || !uid) return;
      await db
        .doc(`signups/${uid}`)
        .set({ company_name: company.company_name, manager_name: company.manager_name, phone: company.phone, signed_up_at: new Date().toISOString() })
        .catch(() => {});
    },
    async onFeedback(company, body) {
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : '';
      if (!message) throw new HttpError(400, 'Please write your feedback', { message: 'Feedback is required' });
      if (!db || !uid) return;
      const ref = db.doc(`feedback/${uid}`);
      const snap = await ref.get();
      const items = snap.exists ? [...(snap.data().items || [])] : [];
      items.push({ message, page: String(body.page || '').slice(0, 200), at: new Date().toISOString() });
      await ref.set({ company_name: company.company_name, manager_name: company.manager_name, phone: company.phone, items: items.slice(-100) });
    },
  });

  // Saving: debounce bursts of edits into one save, one save at a time.
  let dirty = false;
  let saving = false;
  let timer = null;
  async function flush() {
    if (!persistence || saving || !dirty) return;
    saving = true;
    dirty = false;
    setStatus('Saving…');
    try {
      await persistence.save(backend.export());
      setStatus('All changes saved', 'ok');
    } catch (err) {
      dirty = true;
      setStatus(saveErrorMessage(err), 'bad');
    } finally {
      saving = false;
      if (dirty && !timer) timer = setTimeout(run, SAVE_DELAY_MS * 3);
    }
  }
  function run() {
    timer = null;
    flush();
  }
  function scheduleSave() {
    if (!persistence) return;
    dirty = true;
    setStatus('Unsaved changes…');
    clearTimeout(timer);
    timer = setTimeout(run, SAVE_DELAY_MS);
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) {
      flush();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Route the app's /api calls to the in-page backend.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    const method = String(init.method || 'GET').toUpperCase();
    const r = await backend.request(method, url, init.body);
    if (r.changed && r.status < 400) scheduleSave();
    if (r.file) {
      return new Response(new Blob([r.file.bytes], { type: r.file.mime }), {
        status: r.status,
        headers: { 'Content-Type': r.file.mime, 'X-File-Name': encodeURIComponent(r.file.name) },
      });
    }
    if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: r.headers });
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  // Files and CSV exports are links to /api/...; hand them to the viewer as downloads.
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a[href^="/api/"]');
    if (!link) return;
    e.preventDefault();
    const res = await fetch(link.getAttribute('href'));
    if (!res.ok) return;
    const blob = await res.blob();
    const named = res.headers.get('X-File-Name');
    const disposition = res.headers.get('Content-Disposition') || '';
    const filename = named ? decodeURIComponent(named) : (disposition.match(/filename="([^"]+)"/) || [])[1] || 'download';
    const downloads = await useCapability('downloads');
    if (downloads) {
      downloads.save({ filename, data: blob }).catch(() => {});
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  });

  // Login/signup and the app share this document; switch between them.
  window.PM_NAVIGATE = (path) => {
    const inApp = path === '/';
    $('#auth-screen').hidden = inApp;
    $('#app-screen').hidden = !inApp;
    if (inApp) window.PM_startApp();
    else window.PM_showAuth(path === '/signup' ? 'signup' : 'login');
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('a[href="/login"], a[href="/signup"]');
    if (!tab) return;
    e.preventDefault();
    window.PM_NAVIGATE(tab.getAttribute('href'));
  });

  if (!persistence) {
    $('#demo-banner').hidden = false;
    setStatus('Not saved (preview)', 'bad');
  } else if (bytes) {
    setStatus('All changes saved', 'ok');
  } else {
    setStatus('');
  }

  $('#demo-splash').hidden = true;
  const me = await backend.request('GET', '/api/auth/me');
  window.PM_NAVIGATE(me.status === 200 ? '/' : (await backend.hasAccount()) ? '/login' : '/signup');
}

boot().catch((err) => {
  console.error(err);
  showFatal(`The app could not start: ${err.message || err}`);
});
