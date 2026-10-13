'use strict';

const { resources } = require('./schema');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// SQL expression that turns a foreign key column into a human readable label.
const LABEL_SQL = {
  properties: (col) => `(SELECT name FROM properties WHERE id = ${col})`,
  tenants: (col) => `(SELECT full_name FROM tenants WHERE id = ${col})`,
  contacts: (col) => `(SELECT name FROM contacts WHERE id = ${col})`,
  agreements: (col) =>
    `(SELECT tn.full_name || ' @ ' || p.name FROM agreements a ` +
    `JOIN tenants tn ON tn.id = a.tenant_id JOIN properties p ON p.id = a.property_id ` +
    `WHERE a.id = ${col})`,
};

const TEXT_TYPES = new Set(['text', 'textarea', 'email', 'phone', 'select']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getResource(name) {
  if (!Object.prototype.hasOwnProperty.call(resources, name)) {
    throw new HttpError(404, `Unknown resource: ${name}`);
  }
  return resources[name];
}

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns [value, error]. `undefined` input means "not provided".
function coerce(field, raw) {
  if (raw === undefined) return [undefined, null];
  if (raw === null || raw === '') return [null, null];

  switch (field.type) {
    case 'number':
    case 'money':
    case 'ref': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return [null, 'must be a number'];
      if ((field.type === 'number' || field.type === 'ref') && !Number.isInteger(n)) {
        return [null, 'must be a whole number'];
      }
      if (field.type === 'ref' && n <= 0) return [null, 'is not a valid reference'];
      if (field.min !== undefined && n < field.min) return [null, `must be at least ${field.min}`];
      if (field.max !== undefined && n > field.max) return [null, `must be at most ${field.max}`];
      return [field.type === 'money' ? Math.round(n * 100) / 100 : n, null];
    }
    case 'bool': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on') return [1, null];
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return [0, null];
      return [null, 'must be true or false'];
    }
    case 'date': {
      const s = String(raw).trim();
      return isValidDate(s) ? [s, null] : [null, 'must be a date (YYYY-MM-DD)'];
    }
    case 'month': {
      const s = String(raw).trim();
      return MONTH_RE.test(s) ? [s, null] : [null, 'must be a month (YYYY-MM)'];
    }
    case 'datetime': {
      const s = String(raw).trim();
      if (!DATETIME_RE.test(s) || !isValidDate(s.slice(0, 10))) {
        return [null, 'must be a date and time (YYYY-MM-DDTHH:MM)'];
      }
      return [s.slice(0, 16), null];
    }
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number') return [null, 'must be text'];
      const s = String(raw).trim();
      if (s.length > 5000) return [null, 'is too long'];
      if (s === '') return [null, null];
      if (field.type === 'email' && !EMAIL_RE.test(s)) return [null, 'must be a valid email'];
      if (field.type === 'select' && !field.options.includes(s)) {
        return [null, `must be one of: ${field.options.join(', ')}`];
      }
      return [s, null];
    }
  }
}

function crossFieldErrors(resourceName, row) {
  const errors = {};
  if (resourceName === 'agreements' && row.start_date && row.end_date && row.end_date < row.start_date) {
    errors.end_date = 'must be on or after the start date';
  }
  if (resourceName === 'schedules' && row.starts_at && row.ends_at && row.ends_at < row.starts_at) {
    errors.ends_at = 'must be after the start time';
  }
  return errors;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  // Validates `input` and returns the column values to write.
  // For updates, `existing` is the current row; missing fields keep their value.
  validate(resourceName, input, existing) {
    const def = getResource(resourceName);
    const values = {};
    const errors = {};

    for (const field of def.fields) {
      if (field.type === 'file') continue; // handled by the server
      let [value, err] = coerce(field, input[field.name]);
      if (err) {
        errors[field.name] = `${field.label} ${err}`;
        continue;
      }
      if (value === undefined && !existing && field.default !== undefined) value = field.default;
      if (value !== undefined) values[field.name] = value;

      const finalValue = value !== undefined ? value : existing ? existing[field.name] : undefined;
      if (field.required && (finalValue === undefined || finalValue === null)) {
        errors[field.name] = `${field.label} is required`;
      }
    }

    Object.assign(errors, crossFieldErrors(resourceName, { ...existing, ...values }));
    if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', errors);
    return values;
  }

  selectSql(resourceName) {
    const def = getResource(resourceName);
    const extra = def.fields
      .filter((f) => f.type === 'ref' && LABEL_SQL[f.ref])
      .map((f) => `${LABEL_SQL[f.ref](`t.${f.name}`)} AS ${f.name}_label`);
    const label = LABEL_SQL[resourceName] ? `, ${LABEL_SQL[resourceName]('t.id')} AS _label` : '';
    return `SELECT t.*${extra.length ? ', ' + extra.join(', ') : ''}${label} FROM ${resourceName} t`;
  }

  list(resourceName, query = {}) {
    const def = getResource(resourceName);
    const where = [];
    const params = [];

    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      const searchable = def.fields.filter((f) => TEXT_TYPES.has(f.type) || f.type === 'date' || f.type === 'month');
      const ors = searchable.map((f) => `t.${f.name} LIKE ?`);
      for (const f of def.fields.filter((x) => x.type === 'ref' && LABEL_SQL[x.ref])) {
        ors.push(`${LABEL_SQL[f.ref](`t.${f.name}`)} LIKE ?`);
      }
      if (ors.length) {
        where.push(`(${ors.join(' OR ')})`);
        for (let i = 0; i < ors.length; i++) params.push(`%${q}%`);
      }
    }

    // Exact-match filters on any field, e.g. ?status=Active&property_id=3
    for (const field of def.fields) {
      if (field.type === 'file' || query[field.name] === undefined || query[field.name] === '') continue;
      const [value, err] = coerce(field, query[field.name]);
      if (err) throw new HttpError(400, `Filter ${field.label} ${err}`);
      where.push(`t.${field.name} = ?`);
      params.push(value);
    }

    let sql = this.selectSql(resourceName);
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;

    const sortable = new Set(['id', 'created_at', 'updated_at', ...def.fields.filter((f) => f.type !== 'file').map((f) => f.name)]);
    const sort = sortable.has(query.sort) ? query.sort : 'id';
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY t.${sort} ${dir}, t.id ${dir}`;

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 5000);
    sql += ` LIMIT ${limit}`;
    return this.db.prepare(sql).all(...params);
  }

  options(resourceName) {
    getResource(resourceName);
    const label = LABEL_SQL[resourceName] ? LABEL_SQL[resourceName]('t.id') : `'#' || t.id`;
    return this.db.prepare(`SELECT t.id, ${label} AS label FROM ${resourceName} t ORDER BY label COLLATE NOCASE`).all();
  }

  get(resourceName, id) {
    const row = this.db.prepare(`${this.selectSql(resourceName)} WHERE t.id = ?`).get(Number(id));
    if (!row) throw new HttpError(404, `${getResource(resourceName).singular} not found`);
    return row;
  }

  create(resourceName, input, extraColumns = {}) {
    const values = { ...this.validate(resourceName, input, null), ...extraColumns };
    const cols = Object.keys(values);
    const sql = cols.length
      ? `INSERT INTO ${resourceName} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${resourceName} DEFAULT VALUES`;
    const result = this.run(sql, cols.map((c) => values[c]));
    return this.get(resourceName, result.lastInsertRowid);
  }

  update(resourceName, id, input, extraColumns = {}) {
    const existing = this.get(resourceName, id);
    const values = { ...this.validate(resourceName, input, existing), ...extraColumns };
    const cols = Object.keys(values);
    if (cols.length) {
      const sets = cols.map((c) => `${c} = ?`).join(', ');
      this.run(`UPDATE ${resourceName} SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [
        ...cols.map((c) => values[c]),
        existing.id,
      ]);
    }
    return this.get(resourceName, id);
  }

  remove(resourceName, id) {
    const existing = this.get(resourceName, id);
    this.run(`DELETE FROM ${resourceName} WHERE id = ?`, [existing.id]);
    return existing;
  }

  run(sql, params) {
    try {
      return this.db.prepare(sql).run(...params);
    } catch (err) {
      const msg = String(err.message);
      if (msg.includes('FOREIGN KEY')) {
        throw new HttpError(409, 'This record is linked to other records (or links to one that does not exist).');
      }
      throw err;
    }
  }
}

module.exports = { Store, HttpError, getResource, LABEL_SQL };
