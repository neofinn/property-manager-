'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resources } = require('./schema');
const db = require('./db');
const { Store, HttpError, getResource } = require('./store');
const { computeReminders, computeDashboard } = require('./reminders');

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
};

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
  const auth = options.password ? { user: options.user || 'admin', password: options.password } : null;
  const uploadsDir = path.join(dataDir, 'uploads');
  const database = db.open(dataDir);
  const store = new Store(database);

  function fileFields(resourceName) {
    return getResource(resourceName).fields.filter((f) => f.type === 'file');
  }

  // Turns `{ name, type, data(base64) }` from the client into stored columns.
  function saveUploads(resourceName, body) {
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

  function deleteStored(stored) {
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) {
      fs.rmSync(path.join(uploadsDir, stored), { force: true });
    }
  }

  function withUploads(resourceName, body, action) {
    const { columns, written } = saveUploads(resourceName, body);
    try {
      return action(columns);
    } catch (err) {
      written.forEach(deleteStored);
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
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
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
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
    });
  }

  function checkAuth(req) {
    if (!auth) return true;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    const expected = Buffer.from(`${auth.user}:${auth.password}`);
    const given = Buffer.from(`${user}:${rest.join(':')}`);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  async function handleApi(req, res, parts, query) {
    const method = req.method;
    const reminderOpts = () => ({
      today: /^\d{4}-\d{2}-\d{2}$/.test(query.today || '') ? query.today : undefined,
      horizon: Math.min(Math.max(parseInt(query.days, 10) || 7, 0), 90),
      currency,
    });

    if (parts[0] === 'config' && method === 'GET') {
      return send(res, 200, { currency, resources });
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
        const row = withUploads(resourceName, body, (cols) => store.create(resourceName, body, cols));
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
      const content = fs.readFileSync(path.join(uploadsDir, stored));
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
        const row = withUploads(resourceName, body, (cols) => store.update(resourceName, id, body, cols));
        for (const f of fileFields(resourceName)) {
          if (before[`${f.name}_stored`] !== row[`${f.name}_stored`]) deleteStored(before[`${f.name}_stored`]);
        }
        return send(res, 200, publicRow(resourceName, row));
      }
      if (method === 'DELETE') {
        const row = store.remove(resourceName, id);
        for (const f of fileFields(resourceName)) deleteStored(row[`${f.name}_stored`]);
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(405, 'Method not allowed');
  }

  async function handler(req, res) {
    try {
      if (!checkAuth(req)) {
        return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Property Manager", charset="UTF-8"' });
      }
      const url = new URL(req.url, 'http://localhost');
      const query = Object.fromEntries(url.searchParams);
      if (url.pathname.startsWith('/api/')) {
        const parts = url.pathname.slice(5).split('/').filter(Boolean);
        return await handleApi(req, res, parts, query);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.message, details: err.details || null });
      }
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  }

  handler.close = () => database.close();
  handler.db = database;
  return handler;
}

module.exports = { createApp };
