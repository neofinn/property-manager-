'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store, HttpError } = require('./store');
const { handleTenantApi } = require('./api');
const { Platform, normalizePhone } = require('./platform');
const { dbFiles } = require('./files');
const { loadSampleData } = require('./sample');
const { handleAdminApi } = require('./admin');

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
const ADMIN_COOKIE = 'pm_admin';
// Pages anyone can open; everything else needs a logged-in company.
const AUTH_PAGES = { '/login': 'auth.html', '/signup': 'auth.html' };
const PUBLIC_ASSETS = new Set([
  '/app.js',
  '/auth.js',
  '/admin.js',
  '/styles.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
]);

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
  const platform = new Platform({
    dataDir,
    databaseUrl: options.databaseUrl,
    defaultCountryCode: options.defaultCountryCode,
    inviteCode: options.inviteCode,
    adminPassword: options.adminPassword,
  });
  const ready = platform.init();

  function serveStatic(req, res, pathname, page) {
    let rel = page;
    if (!rel) {
      try {
        rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
      } catch {
        return send(res, 400, 'Bad request');
      }
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

  function clientIp(req) {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || '';
  }

  function isHttps(req) {
    return Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function cookie(req, name, token, maxAge, sameSite = 'Lax') {
    const secure = isHttps(req) ? '; Secure' : '';
    return `${name}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
  }

  const cookies = (req) => parseCookies(req.headers.cookie);
  const sessionToken = (req) => cookies(req)[SESSION_COOKIE] || '';

  async function startSession(req, res, company, status) {
    const { token, maxAge } = await platform.createSession(company.id);
    return send(res, status, { company }, { 'Set-Cookie': cookie(req, SESSION_COOKIE, token, maxAge) });
  }

  async function handleAuth(req, res, action) {
    if (action === 'signup' && req.method === 'POST') {
      const company = await platform.signup(await readJson(req));
      return startSession(req, res, company, 201);
    }
    if (action === 'login' && req.method === 'POST') {
      const body = await readJson(req);
      const company = await platform.login(body.phone, body.password, clientIp(req));
      return startSession(req, res, company, 200);
    }
    if (action === 'logout' && req.method === 'POST') {
      await platform.logout(sessionToken(req));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, SESSION_COOKIE, '', 0) });
    }
    if (action === 'config' && req.method === 'GET') {
      return send(res, 200, await platform.publicConfig());
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleApi(req, res, parts, query, company) {
    const settings = await platform.settings();
    const result = await platform.withTenant(company.id, (database) =>
      handleTenantApi(
        {
          database,
          store: new Store(database),
          files: dbFiles(database, { decodeBase64: (b64) => Buffer.from(b64, 'base64'), legacyDir: platform.legacyUploadsDir(company.id) }),
          currency,
          maxFileBytes: MAX_FILE_BYTES,
          notice: settings.notice,
          readOnly: settings.read_only === '1',
          onFeedback: (body) => platform.addFeedback(company.id, body),
        },
        { method: req.method, parts, query, company, readBody: () => readJson(req) },
      ),
    );
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
      await ready;
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
        if (parts[0] === 'admin') {
          const result = await handleAdminApi(platform, {
            method: req.method,
            parts: parts.slice(1),
            readBody: () => readJson(req),
            token: cookies(req)[ADMIN_COOKIE] || '',
            clientKey: clientIp(req),
          });
          const headers = {};
          if (result.setToken !== undefined) {
            headers['Set-Cookie'] = cookie(req, ADMIN_COOKIE, result.setToken, result.maxAge || 0, 'Strict');
          }
          if (result.download) {
            headers['Content-Disposition'] = `attachment; filename="${result.download}"`;
          }
          return send(res, result.status, result.json, headers);
        }
        if (parts[0] === 'auth') {
          if (parts[1] === 'me' && req.method === 'GET') {
            const company = await platform.companyForToken(sessionToken(req));
            if (!company) throw new HttpError(401, 'Please log in');
            return send(res, 200, { company });
          }
          return await handleAuth(req, res, parts[1]);
        }
        const company = await platform.companyForToken(sessionToken(req));
        if (!company) throw new HttpError(401, 'Please log in');
        return await handleApi(req, res, parts, query, company);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (pathname === '/admin') {
        return platform.adminEnabled() ? serveStatic(req, res, pathname, 'admin.html') : send(res, 404, 'Not found');
      }
      const loggedIn = Boolean(await platform.companyForToken(sessionToken(req)));
      if (AUTH_PAGES[pathname]) {
        return loggedIn ? send(res, 302, '', { Location: '/' }) : serveStatic(req, res, pathname, AUTH_PAGES[pathname]);
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
  handler.createDemoAccount = async (input) => {
    await ready;
    const phone = normalizePhone(input.phone, options.defaultCountryCode || '91');
    if (await platform.db.get('SELECT id FROM companies WHERE phone = ?', phone)) return { created: false };
    const company = await platform.signup(input);
    await platform.withTenant(company.id, (db) => loadSampleData(new Store(db)));
    return { created: true, company };
  };

  handler.ready = ready;
  handler.platform = platform;
  handler.close = async () => {
    await ready.catch(() => {});
    await platform.close();
  };
  return handler;
}

module.exports = { createApp };
