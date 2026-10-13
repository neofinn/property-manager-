'use strict';

// The company-scoped REST API, independent of how requests arrive. The Node
// server (src/app.js) and the in-browser demo (src/browser/) both call
// handleTenantApi with:
//   env  = { database, store, files, currency, maxFileBytes, onFeedback(body) }
//   req  = { method, parts, query, readBody: async () => object, company }
// `files` stores uploaded bytes: save(base64) -> { stored, size },
// read(stored) -> bytes, remove(stored).
// It resolves { status, json } | { status, text, headers } | { status, file }.

const { resources } = require('./schema');
const { HttpError, getResource } = require('./store');
const { computeReminders, computeDashboard } = require('./reminders');
const { loadSampleData, isEmpty } = require('./sample');

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/;

function fileFields(resourceName) {
  return getResource(resourceName).fields.filter((f) => f.type === 'file');
}

function basename(name) {
  return String(name).split(/[\\/]/).pop();
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function publicRow(resourceName, row) {
  const out = { ...row };
  for (const field of fileFields(resourceName)) {
    delete out[`${field.name}_stored`];
    out[`${field.name}_url`] = row[`${field.name}_stored`] ? `/api/${resourceName}/${row.id}/${field.name}` : null;
  }
  return out;
}

// Turns `{ name, type, data(base64) }` from the client into stored columns.
function saveUploads(env, resourceName, body) {
  const columns = {};
  const written = [];
  const maxBytes = env.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  for (const field of fileFields(resourceName)) {
    const upload = body[field.name];
    if (upload === undefined) continue;
    if (upload === null) {
      for (const suffix of ['name', 'stored', 'mime', 'size']) columns[`${field.name}_${suffix}`] = null;
      continue;
    }
    if (typeof upload !== 'object' || typeof upload.data !== 'string' || typeof upload.name !== 'string') {
      throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} upload is malformed` });
    }
    // base64 is 4 characters per 3 bytes: reject oversized uploads before decoding them.
    if (upload.data.length > Math.ceil(maxBytes / 3) * 4 + 4) {
      throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} must be under ${Math.round(maxBytes / 1048576)} MB` });
    }
    const { stored, size } = env.files.save(upload.data);
    if (!size) {
      env.files.remove(stored);
      throw new HttpError(400, 'Validation failed', { [field.name]: `${field.label} is empty` });
    }
    written.push(stored);
    const mime = typeof upload.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(upload.type) ? upload.type : 'application/octet-stream';
    Object.assign(columns, {
      [`${field.name}_name`]: basename(upload.name).slice(0, 255) || 'file',
      [`${field.name}_stored`]: stored,
      [`${field.name}_mime`]: mime,
      [`${field.name}_size`]: size,
    });
  }
  return { columns, written };
}

function withUploads(env, resourceName, body, action) {
  const { columns, written } = saveUploads(env, resourceName, body);
  try {
    return action(columns);
  } catch (err) {
    written.forEach((stored) => env.files.remove(stored));
    throw err;
  }
}

async function handleTenantApi(env, req) {
  const { database, store, currency } = env;
  const { method, parts, query, company } = req;
  const reminderOpts = () => ({
    today: /^\d{4}-\d{2}-\d{2}$/.test(query.today || '') ? query.today : undefined,
    horizon: Math.min(Math.max(parseInt(query.days, 10) || 7, 0), 90),
    currency,
  });

  if (parts[0] === 'config' && method === 'GET') {
    return { status: 200, json: { currency, resources, company, empty: isEmpty(database) } };
  }
  if (parts[0] === 'sample-data' && method === 'POST') {
    if (!isEmpty(database)) throw new HttpError(409, 'Sample data can only be loaded into an empty account');
    loadSampleData(store);
    return { status: 201, json: { ok: true } };
  }
  if (parts[0] === 'feedback' && method === 'POST') {
    await env.onFeedback(await req.readBody());
    return { status: 201, json: { ok: true } };
  }
  if (parts[0] === 'dashboard' && method === 'GET') {
    return { status: 200, json: computeDashboard(database, reminderOpts()) };
  }
  if (parts[0] === 'reminders' && parts.length === 1 && method === 'GET') {
    return { status: 200, json: computeReminders(database, reminderOpts()) };
  }
  if (parts[0] === 'reminders' && parts[1] === 'log' && method === 'POST') {
    const body = await req.readBody();
    const key = typeof body.key === 'string' ? body.key.slice(0, 200) : '';
    const channel = ['whatsapp', 'sms', 'email', 'call', 'manual'].includes(body.channel) ? body.channel : null;
    if (!key || !channel) throw new HttpError(400, 'key and a valid channel are required');
    database.prepare('INSERT INTO reminder_log (reminder_key, channel) VALUES (?, ?)').run(key, channel);
    return { status: 201, json: { ok: true } };
  }

  const [resourceName, id, sub] = parts;
  getResource(resourceName);
  if (id !== undefined && id !== 'options' && id !== 'export.csv' && !/^\d+$/.test(id)) {
    throw new HttpError(404, 'Not found');
  }

  if (!id) {
    if (method === 'GET') return { status: 200, json: store.list(resourceName, query).map((r) => publicRow(resourceName, r)) };
    if (method === 'POST') {
      const body = await req.readBody();
      const row = withUploads(env, resourceName, body, (cols) => store.create(resourceName, body, cols));
      return { status: 201, json: publicRow(resourceName, row) };
    }
  } else if (id === 'options' && method === 'GET') {
    return { status: 200, json: store.options(resourceName) };
  } else if (id === 'export.csv' && method === 'GET') {
    const def = getResource(resourceName);
    const cols = ['id'];
    for (const f of def.fields) {
      cols.push(f.type === 'file' ? `${f.name}_name` : f.name);
      if (f.type === 'ref') cols.push(`${f.name}_label`);
    }
    cols.push('created_at', 'updated_at');
    const rows = store.list(resourceName, { ...query, limit: 5000 });
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
    return {
      status: 200,
      text: csv,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${resourceName}.csv"` },
    };
  } else if (sub) {
    const field = fileFields(resourceName).find((f) => f.name === sub);
    if (!field || method !== 'GET') throw new HttpError(404, 'Not found');
    const row = store.get(resourceName, id);
    const stored = row[`${field.name}_stored`];
    if (!stored) throw new HttpError(404, 'No file uploaded');
    const mime = row[`${field.name}_mime`] || 'application/octet-stream';
    return {
      status: 200,
      file: {
        bytes: env.files.read(stored),
        mime,
        name: row[`${field.name}_name`] || 'file',
        inline: INLINE_MIME.test(mime) && query.download === undefined,
      },
    };
  } else {
    if (method === 'GET') return { status: 200, json: publicRow(resourceName, store.get(resourceName, id)) };
    if (method === 'PUT' || method === 'PATCH') {
      const body = await req.readBody();
      const before = store.get(resourceName, id);
      const row = withUploads(env, resourceName, body, (cols) => store.update(resourceName, id, body, cols));
      for (const f of fileFields(resourceName)) {
        if (before[`${f.name}_stored`] !== row[`${f.name}_stored`]) env.files.remove(before[`${f.name}_stored`]);
      }
      return { status: 200, json: publicRow(resourceName, row) };
    }
    if (method === 'DELETE') {
      const row = store.remove(resourceName, id);
      for (const f of fileFields(resourceName)) env.files.remove(row[`${f.name}_stored`]);
      return { status: 200, json: { ok: true } };
    }
  }
  throw new HttpError(405, 'Method not allowed');
}

module.exports = { handleTenantApi };
