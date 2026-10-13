'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resources } = require('./schema');
const db = require('./db');
const { Store, HttpError, getResource } = require('./store');
const { computeReminders, computeDashboard } = require('./reminders');
const { Accounts, normalizePhone } = require('./accounts');
const { loadSampleData, isEmpty } = require('./sample');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const SESSION_COOKIE = 'pm_session';
// Pages anyone can open; everything else needs a logged-in company.
const AUTH_PAGES = { '/login': 'auth.html', '/signup': 'auth.html' };
const PUBLIC_ASSETS = new Set(['/app.js', '/auth.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuffer || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'Expected a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const currency = options.currency || 'INR';
  const trustProxy = Boolean(options.trustProxy);
  const accounts = new Accounts(dataDir, { defaultCountryCode: options.defaultCountryCode, inviteCode: options.inviteCode });

  // Each company's CRM data and uploads live in their own folder and database.
  const tenants = new Map();
  function tenant(companyId) {
    let ctx = tenants.get(companyId);
    if (!ctx) {
      const dir = path.join(dataDir, 'companies', String(companyId));
      const database = db.open(dir);
      ctx = { database, store: new Store(database), uploadsDir: path.join(dir, 'uploads') };
      tenants.set(companyId, ctx);
    }
    return ctx;
  }

  function fileFields(resourceName) {
    return getResource(resourceName).fields.filter((f) => f.type === 'file');
  }

  // Turns `{ name, type, data(base64) }` from the client into stored columns.
  function saveUploads({ uploadsDir }, resourceName, body) {
    const columns = {};
    const written = [];
    for (const field of fileFields(resourceName)) {
      const upload = body[field.name];
      if (upload === undefined) continue;
      if (upload === null) {
        for (const suffix of db.FILE_COLUMNS) columns[`${field.name}_${suffix}`] = null;
        continue;
      }
      if (typeof upload !== 'object' || typeof upload.data !== 'string' || typeof upload.name !== 'string') {
        throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} upload is malformed` });
      }
      const buffer = Buffer.from(upload.data, 'base64');
      if (!buffer.length) throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} is empty` });
      if (buffer.length > MAX_FILE_BYTES) {
        throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} must be under 10 MB` });
      }
      const stored = crypto.randomUUID();
      fs.writeFileSync(path.join(uploadsDir, stored), buffer);
      written.push(stored);
      const mime = typeof upload.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(upload.type) ? upload.type : 'application/octet-stream';
      Object.assign(columns, {
        [`${field.name}_name`]: path.basename(upload.name).slice(0, 255) || 'file',
        [`${field.name}_stored`]: stored,
        [`${field.name}_mime`]: mime,
        [`${field.name}_size`]: buffer.length,
      });
    }
    return { columns, written };
  }

  function deleteStored({ uploadsDir }, stored) {
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) {
      fs.rmSync(path.join(uploadsDir, stored), { force: true });
    }
  }

  function withUploads(ctx, resourceName, body, action) {
    const { columns, written } = saveUploads(ctx, resourceName, body);
    try {
      return action(columns);
    } catch (err) {
      written.forEach((stored) => deleteStored(ctx, stored));
      throw err;
    }
  }

  function publicRow(resourceName, row) {
    const out = { ...row };
    for (const field of fileFields(resourceName)) {
      delete out[`${field.name}_stored`];
      out[`${field.name}_url`] = row[`${field.name}_stored`]
        ? `/api/${resourceName}/${row.id}/${field.name}`
        : null;
    }
    return out;
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = AUTH_PAGES[pathname] || (pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''));
    } catch {
      return send(res, 400, 'Bad request');
    }
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(filePath, (err, content) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, content, {
        'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
    });
  }

  // Before accounts existed all data lived directly in DATA_DIR. The first
  // company to sign up takes it over.
  function adoptLegacyData(companyId) {
    const legacy = path.join(dataDir, 'crm.sqlite');
    if (!fs.existsSync(legacy) || accounts.db.prepare('SELECT COUNT(*) AS n FROM companies').get().n !== 1) return;
    const dir = path.join(dataDir, 'companies', String(companyId));
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['crm.sqlite', 'crm.sqlite-wal', 'crm.sqlite-shm', 'uploads']) {
      const from = path.join(dataDir, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name));
    }
  }

  function clientIp(req) {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || '';
  }

  function isHttps(req) {
    return Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function sessionCookie(req, token, maxAge) {
    const secure = isHttps(req) ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  function sessionToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  }

  function startSession(req, res, company, status) {
    const { token, maxAge } = accounts.createSession(company.id);
    return send(res, status, { company }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }

  async function handleAuth(req, res, action) {
    if (action === 'signup' && req.method === 'POST') {
      const company = accounts.signup(await readJson(req));
      adoptLegacyData(company.id);
      return startSession(req, res, company, 201);
    }
    if (action === 'login' && req.method === 'POST') {
      const body = await readJson(req);
      const company = accounts.login(body.phone, body.password, clientIp(req));
      return startSession(req, res, company, 200);
    }
    if (action === 'logout' && req.method === 'POST') {
      accounts.logout(sessionToken(req));
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (action === 'config' && req.method === 'GET') {
      return send(res, 200, { inviteRequired: Boolean(options.inviteCode), beta: true });
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleApi(req, res, parts, query, company) {
    const method = req.method;
    const ctx = tenant(company.id);
    const { database, store } = ctx;
    const reminderOpts = () => ({
      today: /^\d{4}-\d{2}-\d{2}$/.test(query.today || '') ? query.today : undefined,
      horizon: Math.min(Math.max(parseInt(query.days, 10) || 7, 0), 90),
      currency,
    });

    if (parts[0] === 'config' && method === 'GET') {
      return send(res, 200, { currency, resources, company, empty: isEmpty(database) });
    }
    if (parts[0] === 'sample-data' && method === 'POST') {
      if (!isEmpty(database)) throw new HttpError(409, 'Sample data can only be loaded into an empty account');
      loadSampleData(store);
      return send(res, 201, { ok: true });
    }
    if (parts[0] === 'feedback' && method === 'POST') {
      accounts.addFeedback(company.id, await readJson(req));
      return send(res, 201, { ok: true });
    }
    if (parts[0] === 'dashboard' && method === 'GET') {
      return send(res, 200, computeDashboard(database, reminderOpts()));
    }
    if (parts[0] === 'reminders' && parts.length === 1 && method === 'GET') {
      return send(res, 200, computeReminders(database, reminderOpts()));
    }
    if (parts[0] === 'reminders' && parts[1] === 'log' && method === 'POST') {
      const body = await readJson(req);
      const key = typeof body.key === 'string' ? body.key.slice(0, 200) : '';
      const channel = ['whatsapp', 'sms', 'email', 'call', 'manual'].includes(body.channel) ? body.channel : null;
      if (!key || !channel) throw new HttpError(400, 'key and a valid channel are required');
      database.prepare('INSERT INTO reminder_log (reminder_key, channel) VALUES (?, ?)').run(key, channel);
      return send(res, 201, { ok: true });
    }

    const [resourceName, id, sub] = parts;
    getResource(resourceName);
    if (id !== undefined && id !== 'options' && id !== 'export.csv' && !/^\d+$/.test(id)) {
      throw new HttpError(404, 'Not found');
    }

    if (!id) {
      if (method === 'GET') return send(res, 200, store.list(resourceName, query).map((r) => publicRow(resourceName, r)));
      if (method === 'POST') {
        const body = await readJson(req);
        const row = withUploads(ctx, resourceName, body, (cols) => store.create(resourceName, body, cols));
        return send(res, 201, publicRow(resourceName, row));
      }
    } else if (id === 'options' && method === 'GET') {
      return send(res, 200, store.options(resourceName));
    } else if (id === 'export.csv' && method === 'GET') {
      const def = getResource(resourceName);
      const cols = ['id'];
      for (const f of def.fields) {
        if (f.type === 'file') cols.push(`${f.name}_name`);
        else cols.push(f.name);
        if (f.type === 'ref') cols.push(`${f.name}_label`);
      }
      cols.push('created_at', 'updated_at');
      const rows = store.list(resourceName, { ...query, limit: 5000 });
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${resourceName}.csv"`,
      });
    } else if (sub) {
      const field = fileFields(resourceName).find((f) => f.name === sub);
      if (!field || method !== 'GET') throw new HttpError(404, 'Not found');
      const row = store.get(resourceName, id);
      const stored = row[`${field.name}_stored`];
      if (!stored) throw new HttpError(404, 'No file uploaded');
      const content = fs.readFileSync(path.join(ctx.uploadsDir, stored));
      const mime = row[`${field.name}_mime`] || 'application/octet-stream';
      const disposition = INLINE_MIME.test(mime) && query.download === undefined ? 'inline' : 'attachment';
      const filename = row[`${field.name}_name`] || 'file';
      return send(res, 200, content, {
        'Content-Type': mime,
        'Content-Disposition': `${disposition}; filename="${filename.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-cache',
      });
    } else {
      if (method === 'GET') return send(res, 200, publicRow(resourceName, store.get(resourceName, id)));
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readJson(req);
        const before = store.get(resourceName, id);
        const row = withUploads(ctx, resourceName, body, (cols) => store.update(resourceName, id, body, cols));
        for (const f of fileFields(resourceName)) {
          if (before[`${f.name}_stored`] !== row[`${f.name}_stored`]) deleteStored(ctx, before[`${f.name}_stored`]);
        }
        return send(res, 200, publicRow(resourceName, row));
      }
      if (method === 'DELETE') {
        const row = store.remove(resourceName, id);
        for (const f of fileFields(resourceName)) deleteStored(ctx, row[`${f.name}_stored`]);
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(405, 'Method not allowed');
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams);

      if (pathname === '/healthz') return send(res, 200, 'ok');

      if (pathname.startsWith('/api/')) {
        // Browsers can't send this header cross-site without a CORS preflight,
        // so requiring it on writes blocks cross-site request forgery.
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'fetch') {
          throw new HttpError(403, 'Missing X-Requested-With header');
        }
        const parts = pathname.slice(5).split('/').filter(Boolean);
        if (parts[0] === 'auth') {
          if (parts[1] === 'me' && req.method === 'GET') {
            const company = accounts.companyForToken(sessionToken(req));
            if (!company) throw new HttpError(401, 'Please log in');
            return send(res, 200, { company });
          }
          return await handleAuth(req, res, parts[1]);
        }
        const company = accounts.companyForToken(sessionToken(req));
        if (!company) throw new HttpError(401, 'Please log in');
        return await handleApi(req, res, parts, query, company);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const loggedIn = Boolean(accounts.companyForToken(sessionToken(req)));
      if (AUTH_PAGES[pathname]) {
        return loggedIn ? send(res, 302, '', { Location: '/' }) : serveStatic(req, res, pathname);
      }
      if (!loggedIn && !PUBLIC_ASSETS.has(pathname)) {
        return send(res, 302, '', { Location: '/login' });
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.message, details: err.details || null });
      }
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  }

  // Used by `npm run seed`: a ready-to-try account full of sample data.
  handler.createDemoAccount = (input) => {
    const phone = normalizePhone(input.phone, options.defaultCountryCode || '91');
    const existing = accounts.db.prepare('SELECT id FROM companies WHERE phone = ?').get(phone);
    if (existing) return { created: false };
    const company = accounts.signup(input);
    loadSampleData(tenant(company.id).store);
    return { created: true, company };
  };

  handler.close = () => {
    for (const ctx of tenants.values()) ctx.database.close();
    tenants.clear();
    accounts.close();
  };
  handler.accounts = accounts;
  handler.tenant = tenant;
  return handler;
}

module.exports = { createApp };
