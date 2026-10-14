'use strict';

const { resources } = require('./schema');
const { localToday } = require('./reminders');

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
  rooms: (col) =>
    `(SELECT 'Room ' || r.room_number || ' · ' || p.name FROM rooms r ` +
    `JOIN properties p ON p.id = r.property_id WHERE r.id = ${col})`,
  beds: (col) =>
    `(SELECT b.bed_label || ' · Room ' || r.room_number || ' · ' || p.name FROM beds b ` +
    `JOIN rooms r ON r.id = b.room_id JOIN properties p ON p.id = r.property_id WHERE b.id = ${col})`,
  agreements: (col) =>
    `(SELECT tn.full_name || ' @ ' || p.name FROM agreements a ` +
    `JOIN tenants tn ON tn.id = a.tenant_id JOIN properties p ON p.id = a.property_id ` +
    `WHERE a.id = ${col})`,
};

// A bed (or a room let out as a whole) is occupied by an active tenant.
const OCCUPANT_SQL = (bedCol) =>
  `(SELECT full_name FROM tenants WHERE bed_id = ${bedCol} AND status = 'Active' ORDER BY id LIMIT 1)`;
const OCCUPIED_BEDS_SQL = (where) =>
  `(SELECT COUNT(*) FROM beds b WHERE ${where} AND EXISTS ` +
  `(SELECT 1 FROM tenants x WHERE x.bed_id = b.id AND x.status = 'Active'))`;

// Read-only columns computed for list and detail views.
const COMPUTED_SQL = {
  properties: {
    room_count: '(SELECT COUNT(*) FROM rooms WHERE property_id = t.id)',
    bed_count: '(SELECT COUNT(*) FROM beds b JOIN rooms r ON r.id = b.room_id WHERE r.property_id = t.id)',
    occupied_beds: OCCUPIED_BEDS_SQL('b.room_id IN (SELECT id FROM rooms WHERE property_id = t.id)'),
  },
  rooms: {
    bed_count: '(SELECT COUNT(*) FROM beds WHERE room_id = t.id)',
    occupied_beds: OCCUPIED_BEDS_SQL('b.room_id = t.id'),
    tenant_count: "(SELECT COUNT(*) FROM tenants WHERE room_id = t.id AND status = 'Active')",
  },
  beds: {
    occupant: OCCUPANT_SQL('t.id'),
    occupant_id: "(SELECT id FROM tenants WHERE bed_id = t.id AND status = 'Active' ORDER BY id LIMIT 1)",
  },
};

// Extra columns sent with dropdown options. `parent` lets the form show only
// the rooms of the chosen property and the beds of the chosen room.
const OPTION_SQL = {
  properties: 't.type AS type',
  rooms: "t.property_id AS parent, 'Room ' || t.room_number AS short_label, t.rent_per_bed, t.rent_per_room",
  beds: `t.room_id AS parent, t.bed_label AS short_label, t.monthly_rent, t.status, ${OCCUPANT_SQL('t.id')} AS occupant, ` +
    '(SELECT rent_per_bed FROM rooms WHERE id = t.room_id) AS room_rent_per_bed',
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
  // `db` is any backend from src/database.
  constructor(db) {
    this.db = db;
  }

  // Validates `input` and returns the column values to write.
  // For updates, `existing` is the current row; missing fields keep their value.
  async validate(resourceName, input, existing) {
    const def = getResource(resourceName);
    const values = {};
    const errors = {};

    for (const field of def.fields) {
      if (field.type === 'file') continue; // handled by the API layer
      let [value, err] = coerce(field, input[field.name]);
      if (err) {
        errors[field.name] = `${field.label} ${err}`;
        continue;
      }
      if (value === undefined && !existing && field.default !== undefined) value = field.default;
      if (value !== undefined) values[field.name] = value;
    }

    if (!Object.keys(errors).length) Object.assign(errors, await this.linkRoomAndBed(resourceName, input, values, existing));

    for (const field of def.fields) {
      if (!field.required || errors[field.name]) continue;
      const finalValue = values[field.name] !== undefined ? values[field.name] : existing ? existing[field.name] : undefined;
      if (finalValue === undefined || finalValue === null) errors[field.name] = `${field.label} is required`;
    }

    Object.assign(errors, crossFieldErrors(resourceName, { ...existing, ...values }));
    if (!Object.keys(errors).length) Object.assign(errors, await this.occupancyErrors(resourceName, { ...existing, ...values }, existing));
    if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', errors);
    return values;
  }

  // Tenants and agreements can point at a room and bed. Fill in the room and
  // property from the chosen bed (and the property from the room), and reject
  // combinations that don't belong together.
  async linkRoomAndBed(resourceName, input, values, existing) {
    if (resourceName !== 'tenants' && resourceName !== 'agreements') return {};
    const errors = {};
    const current = (name) => (values[name] !== undefined ? values[name] : existing ? existing[name] : null);
    const explicit = (name) => input[name] !== undefined && input[name] !== null && input[name] !== '';

    const bedId = current('bed_id');
    let bed = null;
    if (bedId) {
      bed = await this.db.get('SELECT * FROM beds WHERE id = ?', bedId);
      if (!bed) return { bed_id: 'Bed does not exist' };
      if (current('room_id') !== bed.room_id) {
        if (explicit('room_id')) errors.bed_id = 'Bed is not in the selected room';
        else values.room_id = bed.room_id;
      }
    }

    const roomId = current('room_id');
    let room = null;
    if (roomId) {
      room = await this.db.get('SELECT * FROM rooms WHERE id = ?', roomId);
      if (!room) return { room_id: 'Room does not exist' };
      if (current('property_id') !== room.property_id) {
        if (explicit('property_id')) errors.room_id = 'Room is not in the selected property';
        else values.property_id = room.property_id;
      }
    }

    // Default the agreement rent from the bed or room.
    if (resourceName === 'agreements' && current('monthly_rent') === null && !explicit('monthly_rent')) {
      const rent = bed ? bed.monthly_rent ?? room?.rent_per_bed : room ? room.rent_per_room ?? room.rent_per_bed : null;
      if (rent !== null && rent !== undefined) values.monthly_rent = rent;
    }
    return errors;
  }

  // A bed can have only one active tenant and one active agreement at a time.
  async occupancyErrors(resourceName, row, existing) {
    if (!row.bed_id || row.status !== 'Active') return {};
    const selfId = existing ? existing.id : -1;
    if (resourceName === 'tenants') {
      const other = await this.db.get(
        "SELECT full_name FROM tenants WHERE bed_id = ? AND status = 'Active' AND id != ?",
        row.bed_id,
        selfId,
      );
      if (other) return { bed_id: `Bed is already occupied by ${other.full_name}` };
    }
    if (resourceName === 'agreements' && row.start_date && row.end_date) {
      const other = await this.db.get(
        `SELECT a.start_date, a.end_date, tn.full_name FROM agreements a JOIN tenants tn ON tn.id = a.tenant_id
         WHERE a.bed_id = ? AND a.status = 'Active' AND a.id != ? AND a.start_date <= ? AND a.end_date >= ?`,
        row.bed_id,
        selfId,
        row.end_date,
        row.start_date,
      );
      if (other) {
        return { bed_id: `Bed already has an active agreement with ${other.full_name} (${other.start_date} to ${other.end_date})` };
      }
    }
    return {};
  }

  // Side effects after a successful insert or update, run in the same transaction.
  async afterSave(resourceName, row) {
    if (resourceName === 'rooms') {
      // Create beds up to the room's bed count (never removes any).
      const names = new Set((await this.db.all('SELECT bed_label FROM beds WHERE room_id = ?', row.id)).map((b) => b.bed_label));
      for (let i = 1, added = names.size; added < (row.total_beds || 0); i++) {
        if (names.has(`Bed ${i}`)) continue;
        await this.db.run(
          'INSERT INTO beds (room_id, bed_label, monthly_rent, status) VALUES (?, ?, ?, ?)',
          row.id,
          `Bed ${i}`,
          row.rent_per_bed ?? null,
          'Available',
        );
        added++;
      }
    }
    if (resourceName === 'agreements' && row.status === 'Active' && (row.room_id || row.bed_id)) {
      // Keep the tenant's current room and bed in step with their active agreement.
      const tenant = await this.db.get('SELECT * FROM tenants WHERE id = ?', row.tenant_id);
      const today = localToday();
      const current = row.start_date <= today && row.end_date >= today;
      if (tenant && (current || (!tenant.bed_id && !tenant.room_id))) {
        const errors = await this.occupancyErrors('tenants', { ...tenant, bed_id: row.bed_id }, tenant);
        if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', errors);
        await this.db.run(
          `UPDATE tenants SET property_id = ?, room_id = ?, bed_id = ?, updated_at = ${this.db.dialect.now} WHERE id = ?`,
          row.property_id,
          row.room_id,
          row.bed_id,
          tenant.id,
        );
      }
    }
  }

  selectSql(resourceName) {
    const def = getResource(resourceName);
    const extra = def.fields
      .filter((f) => f.type === 'ref' && LABEL_SQL[f.ref])
      .map((f) => `${LABEL_SQL[f.ref](`t.${f.name}`)} AS ${f.name}_label`);
    for (const [name, sql] of Object.entries(COMPUTED_SQL[resourceName] || {})) extra.push(`${sql} AS ${name}`);
    const label = LABEL_SQL[resourceName] ? `, ${LABEL_SQL[resourceName]('t.id')} AS _label` : '';
    return `SELECT t.*${extra.length ? ', ' + extra.join(', ') : ''}${label} FROM ${resourceName} t`;
  }

  async list(resourceName, query = {}) {
    const def = getResource(resourceName);
    const where = [];
    const params = [];
    const like = this.db.dialect.like;

    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      const searchable = def.fields.filter((f) => TEXT_TYPES.has(f.type) || f.type === 'date' || f.type === 'month');
      const ors = searchable.map((f) => `t.${f.name} ${like} ?`);
      for (const f of def.fields.filter((x) => x.type === 'ref' && LABEL_SQL[x.ref])) {
        ors.push(`${LABEL_SQL[f.ref](`t.${f.name}`)} ${like} ?`);
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
    return this.db.all(sql, ...params);
  }

  async options(resourceName) {
    getResource(resourceName);
    const label = LABEL_SQL[resourceName] ? LABEL_SQL[resourceName]('t.id') : `'#' || t.id`;
    const extra = OPTION_SQL[resourceName] ? `, ${OPTION_SQL[resourceName]}` : '';
    return this.db.all(`SELECT t.id, ${label} AS label${extra} FROM ${resourceName} t ORDER BY ${this.db.dialect.lower(label)}`);
  }

  async get(resourceName, id) {
    const row = await this.db.get(`${this.selectSql(resourceName)} WHERE t.id = ?`, Number(id));
    if (!row) throw new HttpError(404, `${getResource(resourceName).singular} not found`);
    return row;
  }

  async create(resourceName, input, extraColumns = {}) {
    const values = { ...(await this.validate(resourceName, input, null)), ...extraColumns };
    const cols = Object.keys(values);
    const sql = cols.length
      ? `INSERT INTO ${resourceName} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${resourceName} DEFAULT VALUES`;
    return this.db.transaction(async () => {
      const id = await this.write(() => this.db.insert(sql, ...cols.map((c) => values[c])));
      await this.afterSave(resourceName, await this.get(resourceName, id));
      return this.get(resourceName, id);
    });
  }

  async update(resourceName, id, input, extraColumns = {}) {
    const existing = await this.get(resourceName, id);
    const values = { ...(await this.validate(resourceName, input, existing)), ...extraColumns };
    const cols = Object.keys(values);
    return this.db.transaction(async () => {
      if (cols.length) {
        const sets = cols.map((c) => `${c} = ?`).join(', ');
        await this.write(() =>
          this.db.run(
            `UPDATE ${resourceName} SET ${sets}, updated_at = ${this.db.dialect.now} WHERE id = ?`,
            ...cols.map((c) => values[c]),
            existing.id,
          ),
        );
      }
      await this.afterSave(resourceName, await this.get(resourceName, id));
      return this.get(resourceName, id);
    });
  }

  async remove(resourceName, id) {
    const existing = await this.get(resourceName, id);
    await this.write(() => this.db.run(`DELETE FROM ${resourceName} WHERE id = ?`, existing.id));
    return existing;
  }

  // Turns a foreign key failure into a message the user can act on.
  async write(fn) {
    try {
      return await fn();
    } catch (err) {
      if (this.db.dialect.isForeignKeyError(err)) {
        throw new HttpError(409, 'This record is linked to other records (or links to one that does not exist).');
      }
      throw err;
    }
  }
}

module.exports = { Store, HttpError, getResource, LABEL_SQL };
