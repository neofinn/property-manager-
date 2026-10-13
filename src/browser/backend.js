'use strict';

// The whole server, running inside the page for the claude.ai demo. One
// browser database holds one company: its account, CRM records and uploaded
// files. requests mirror the Node server's /api routes.

const { initSchema } = require('../db');
const { Store, HttpError } = require('../store');
const { handleTenantApi } = require('../api');
const { validateSignup, normalizePhone } = require('../account-rules');
const { loadSampleData } = require('../sample');
const { SqlJsDatabase } = require('./sqljs-adapter');

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const PBKDF2_ITERATIONS = 150000;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function randomToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, '');
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromBase64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [scheme, , salt, expected] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = (await hashPassword(password, salt)).split('$')[3];
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function initAccountTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT NOT NULL,
      manager_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS files (stored TEXT PRIMARY KEY, data BLOB NOT NULL);
  `);
}

/**
 * options: { SQL, bytes?, currency, defaultCountryCode, getToken(), setToken(token|null),
 *            onFeedback(company, body), onSignup(company) }
 */
function createBackend(options) {
  const database = new SqlJsDatabase(options.SQL, options.bytes);
  initSchema(database);
  initAccountTables(database);
  const store = new Store(database);
  const currency = options.currency || 'INR';
  const defaultCountryCode = options.defaultCountryCode || '91';

  const files = {
    save(base64) {
      const bytes = fromBase64(base64);
      const stored = crypto.randomUUID();
      database.prepare('INSERT INTO files (stored, data) VALUES (?, ?)').run(stored, bytes);
      return { stored, size: bytes.length };
    },
    read(stored) {
      const row = database.prepare('SELECT data FROM files WHERE stored = ?').get(stored);
      if (!row) throw new HttpError(404, 'File is missing');
      return row.data;
    },
    remove(stored) {
      if (stored) database.prepare('DELETE FROM files WHERE stored = ?').run(stored);
    },
  };

  const account = () => database.prepare('SELECT id, company_name, manager_name, phone, created_at FROM account WHERE id = 1').get() || null;

  function loggedInCompany() {
    const token = options.getToken();
    if (!token) return null;
    return database.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token) ? account() : null;
  }

  function startSession() {
    const token = randomToken();
    database.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
    options.setToken(token);
    return { status: 200, json: { company: account() } };
  }

  async function handleAuth(method, action, body) {
    if (action === 'config' && method === 'GET') {
      return { status: 200, json: { inviteRequired: false, beta: true, hasAccount: Boolean(account()) } };
    }
    if (action === 'me' && method === 'GET') {
      const company = loggedInCompany();
      if (!company) throw new HttpError(401, 'Please log in');
      return { status: 200, json: { company } };
    }
    if (action === 'signup' && method === 'POST') {
      const { values, errors } = validateSignup(body, { defaultCountryCode });
      if (account()) {
        throw new HttpError(400, 'This claude.ai account already has a company. Please log in.', {
          phone: `Already signed up as ${account().company_name}`,
        });
      }
      if (Object.keys(errors).length) throw new HttpError(400, 'Please fix the highlighted fields', errors);
      const hash = await hashPassword(values.password);
      database
        .prepare('INSERT INTO account (id, company_name, manager_name, phone, password_hash) VALUES (1, ?, ?, ?, ?)')
        .run(values.company_name, values.manager_name, values.phone, hash);
      const result = startSession();
      result.status = 201;
      await options.onSignup?.(account());
      return result;
    }
    if (action === 'login' && method === 'POST') {
      const row = database.prepare('SELECT * FROM account WHERE id = 1').get();
      const phone = normalizePhone(body.phone, defaultCountryCode);
      const ok = row && phone === row.phone && (await verifyPassword(typeof body.password === 'string' ? body.password : '', row.password_hash));
      if (!ok) {
        throw new HttpError(401, row ? 'Phone number or password is incorrect' : 'No account yet. Please sign up first.');
      }
      return startSession();
    }
    if (action === 'logout' && method === 'POST') {
      const token = options.getToken();
      if (token) database.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      options.setToken(null);
      return { status: 200, json: { ok: true } };
    }
    throw new HttpError(404, 'Not found');
  }

  // Handles one /api request. Resolves { status, json } | { status, text, headers } | { status, file }
  // plus `changed: true` when the database was modified.
  async function request(method, url, bodyText) {
    const parsed = new URL(url, 'https://demo.invalid');
    const parts = parsed.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    const query = Object.fromEntries(parsed.searchParams);
    const readBody = async () => {
      if (!bodyText) return {};
      try {
        const body = JSON.parse(bodyText);
        if (body && typeof body === 'object' && !Array.isArray(body)) return body;
      } catch {
        // fall through
      }
      throw new HttpError(400, 'Invalid JSON');
    };
    const changed = method !== 'GET';
    try {
      if (parts[0] === 'auth') return { ...(await handleAuth(method, parts[1], await readBody())), changed };
      const company = loggedInCompany();
      if (!company) throw new HttpError(401, 'Please log in');
      const env = {
        database,
        store,
        files,
        currency,
        maxFileBytes: MAX_FILE_BYTES,
        onFeedback: (body) => options.onFeedback?.(company, body),
      };
      return { ...(await handleTenantApi(env, { method, parts, query, company, readBody })), changed };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, json: { error: err.message, details: err.details || null } };
      console.error(err);
      return { status: 500, json: { error: 'Something went wrong in the demo' } };
    }
  }

  return {
    request,
    export: () => database.export(),
    hasAccount: () => Boolean(account()),
    loadSampleData: () => loadSampleData(store),
    database,
  };
}

module.exports = { createBackend, toBase64, fromBase64 };
