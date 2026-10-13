'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { Store, HttpError } = require('./store');
const { handleTenantApi } = require('./api');
const { Accounts, normalizePhone } = require('./accounts');
const { loadSampleData } = require('./sample');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const currency = options.currency || 'INR';
  const trustProxy = Boolean(options.trustProxy);
  const accounts = new Accounts(dataDir, { defaultCountryCode: options.defaultCountryCode, inviteCode: options.inviteCode });

  // Uploaded documents are stored as files named by a random id.
  function diskFiles(uploadsDir) {
    return {
      save(base64) {
        const buffer = Buffer.from(base64, 'base64');
        const stored = crypto.randomUUID();
        fs.writeFileSync(path.join(uploadsDir, stored), buffer);
        return { stored, size: buffer.length };
      },
      read: (stored) => fs.readFileSync(path.join(uploadsDir, stored)),
      remove(stored) {
        if (stored && /^[0-9a-f-]{36}$/.test(stored)) fs.rmSync(path.join(uploadsDir, stored), { force: true });
      },
    };
  }

  // Each company's CRM data and uploads live in their own folder and database.
  const tenants = new Map();
  function tenant(companyId) {
    let ctx = tenants.get(companyId);
    if (!ctx) {
      const dir = path.join(dataDir, 'companies', String(companyId));
      const database = db.open(dir);
      ctx = { database, store: new Store(database), files: diskFiles(path.join(dir, 'uploads')) };
      tenants.set(companyId, ctx);
    }
    return ctx;
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
    const env = {
      ...tenant(company.id),
      currency,
      maxFileBytes: MAX_FILE_BYTES,
      onFeedback: (body) => accounts.addFeedback(company.id, body),
    };
    const result = await handleTenantApi(env, { method: req.method, parts, query, company, readBody: () => readJson(req) });
    if (result.file) {
      const { bytes, mime, name, inline } = result.file;
      return send(res, result.status, Buffer.from(bytes), {
        'Content-Type': mime,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-cache',
      });
    }
    if (result.text !== undefined) return send(res, result.status, result.text, result.headers);
    return send(res, result.status, result.json);
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
