'use strict';

// Everything above a single company: who can log in, sessions, beta feedback,
// platform settings, the developer admin area, and where each company's CRM
// data lives.
//
// Storage:
//   - DATABASE_URL set (e.g. Supabase Postgres): platform tables in `public`,
//     each company's CRM tables in schema `company_<id>`.
//   - otherwise SQLite: DATA_DIR/accounts.sqlite plus DATA_DIR/companies/<id>/crm.sqlite.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./store');
const { initSchema } = require('./db');
const { resources } = require('./schema');
const { normalizePhone, cleanText, validateSignup } = require('./account-rules');
const { SqliteDatabase } = require('./database/sqlite');
const { PostgresDatabase, createPool, withSchema } = require('./database/postgres');
const { localToday } = require('./reminders');

const SESSION_DAYS = 30;
const ADMIN_SESSION_HOURS = 12;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const ACTIVITY_WRITE_EVERY_MS = 5 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, n, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT_PARAMS, N: Number(n) });
  return crypto.timingSafeEqual(expected, actual);
}

// Used when the phone number is unknown so a failed login takes as long as a real one.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isoNow = () => new Date().toISOString();
// Platform timestamps use the same "YYYY-MM-DD HH:MM:SS" UTC text as the database defaults.
const sqlTime = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// One-at-a-time queue: SQLite work for a company runs one request at a time so
// an awaited transaction can't interleave with another request's statements.
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const SETTINGS_DEFAULTS = { signups_open: '1', invite_code: '', notice: '', read_only: '0' };

class Platform {
  constructor({ dataDir, databaseUrl, defaultCountryCode = '91', inviteCode = '', adminPassword = '' }) {
    this.dataDir = dataDir;
    this.defaultCountryCode = defaultCountryCode;
    this.envInviteCode = inviteCode;
    this.adminPassword = adminPassword;
    this.attempts = new Map();
    this.tenants = new Map(); // SQLite: companyId -> { db, lock }
    this.readyTenants = new Set(); // Postgres: schemas already migrated by this process
    this.tenantInit = new Map(); // Postgres: companyId -> migration in progress
    if (databaseUrl) {
      this.pool = createPool(databaseUrl);
      this.db = new PostgresDatabase(this.pool);
      this.storage = 'postgres';
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.db = SqliteDatabase.open(path.join(dataDir, 'accounts.sqlite'));
      this.storage = 'sqlite';
    }
  }

  async init() {
    const { dialect } = this.db;
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        ${dialect.idColumn},
        company_name TEXT NOT NULL,
        manager_name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (${dialect.now}),
        last_login_at TEXT,
        last_active_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (${dialect.now}),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        ${dialect.idColumn},
        company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
        page TEXT,
        message TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (${dialect.now})
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_log (
        ${dialect.idColumn},
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (${dialect.now})
      );
    `);
    // Columns added after the first release of the accounts database.
    const add = async (table, column, sql) => {
      const q = dialect.columnsSql(table);
      const cols = new Set((await this.db.all(q.sql, ...q.params)).map((c) => c.name));
      if (!cols.has(column)) await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
    };
    await add('companies', 'status', "status TEXT NOT NULL DEFAULT 'active'");
    await add('companies', 'last_active_at', 'last_active_at TEXT');
    await add('feedback', 'resolved', 'resolved INTEGER NOT NULL DEFAULT 0');
    if (this.storage === 'postgres') {
      // Supabase serves the public schema through its web API. Row-level security
      // with no policies refuses those requests; the app connects as the owner.
      for (const table of ['companies', 'sessions', 'feedback', 'settings', 'admin_sessions', 'admin_log']) {
        await this.db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }
    }
    return this;
  }

  async close() {
    for (const { db } of this.tenants.values()) await db.close();
    this.tenants.clear();
    if (this.pool) await this.pool.end();
    else await this.db.close();
  }

  // ---------- company data ----------

  // Runs fn(db) against one company's CRM database.
  async withTenant(companyId, fn) {
    const id = Number(companyId);
    if (this.storage === 'postgres') {
      return withSchema(this.pool, `company_${id}`, async (db) => {
        if (!this.readyTenants.has(id)) {
          // Concurrent first requests share one migration run.
          if (!this.tenantInit.has(id)) {
            this.tenantInit.set(id, initSchema(db).finally(() => this.tenantInit.delete(id)));
            await this.tenantInit.get(id);
            this.readyTenants.add(id);
          } else {
            await this.tenantInit.get(id);
          }
        }
        return fn(db);
      });
    }
    let tenant = this.tenants.get(id);
    if (!tenant) {
      const dir = path.join(this.dataDir, 'companies', String(id));
      fs.mkdirSync(dir, { recursive: true });
      const db = SqliteDatabase.open(path.join(dir, 'crm.sqlite'));
      await initSchema(db);
      tenant = { db, lock: createLock(), dir };
      this.tenants.set(id, tenant);
    }
    return tenant.lock(() => fn(tenant.db));
  }

  // Before accounts existed all data lived directly in DATA_DIR (SQLite only).
  // The first company to sign up takes it over.
  async adoptLegacyData(companyId) {
    if (this.storage !== 'sqlite') return;
    const legacy = path.join(this.dataDir, 'crm.sqlite');
    if (!fs.existsSync(legacy) || (await this.db.get('SELECT COUNT(*) AS n FROM companies')).n !== 1) return;
    const dir = path.join(this.dataDir, 'companies', String(companyId));
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['crm.sqlite', 'crm.sqlite-wal', 'crm.sqlite-shm', 'uploads']) {
      const from = path.join(this.dataDir, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name));
    }
  }

  // Uploaded files from before they moved into the database (SQLite only).
  legacyUploadsDir(companyId) {
    return this.storage === 'sqlite' ? path.join(this.dataDir, 'companies', String(Number(companyId)), 'uploads') : null;
  }

  // ---------- settings ----------

  async settings() {
    const rows = await this.db.all('SELECT key, value FROM settings');
    const out = { ...SETTINGS_DEFAULTS };
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  async inviteCode() {
    return (await this.settings()).invite_code || this.envInviteCode;
  }

  async publicConfig() {
    const s = await this.settings();
    return { inviteRequired: Boolean(s.invite_code || this.envInviteCode), signupsOpen: s.signups_open === '1', beta: true, notice: s.notice };
  }

  // ---------- accounts ----------

  publicCompany(row) {
    return {
      id: Number(row.id),
      company_name: row.company_name,
      manager_name: row.manager_name,
      phone: row.phone,
      status: row.status,
      created_at: row.created_at,
    };
  }

  async signup(input) {
    const s = await this.settings();
    if (s.signups_open !== '1') throw new HttpError(403, 'New sign-ups are closed right now. Please try again later.');
    const { values, errors } = validateSignup(input, { defaultCountryCode: this.defaultCountryCode, inviteCode: await this.inviteCode() });
    const { company_name, manager_name, phone, password } = values;
    if (phone && (await this.db.get('SELECT 1 AS x FROM companies WHERE phone = ?', phone))) {
      errors.phone = 'An account with this phone number already exists. Please log in.';
    }
    if (Object.keys(errors).length) throw new HttpError(400, 'Please fix the highlighted fields', errors);

    let id;
    try {
      id = await this.db.insert(
        'INSERT INTO companies (company_name, manager_name, phone, password_hash) VALUES (?, ?, ?, ?)',
        company_name,
        manager_name,
        phone,
        hashPassword(password),
      );
    } catch (err) {
      if (this.db.dialect.isUniqueError(err)) {
        throw new HttpError(400, 'Please fix the highlighted fields', { phone: 'An account with this phone number already exists. Please log in.' });
      }
      throw err;
    }
    await this.adoptLegacyData(id);
    return this.publicCompany(await this.db.get('SELECT * FROM companies WHERE id = ?', id));
  }

  async login(phoneInput, password, clientKey) {
    const phone = normalizePhone(phoneInput, this.defaultCountryCode);
    const key = `${clientKey}|${phone}`;
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes and try again.');
    }

    const row = phone ? await this.db.get('SELECT * FROM companies WHERE phone = ?', phone) : null;
    const ok = verifyPassword(typeof password === 'string' ? password : '', row ? row.password_hash : DUMMY_HASH) && row;
    if (!ok) {
      recent.push(now);
      this.attempts.set(key, recent);
      throw new HttpError(401, 'Phone number or password is incorrect');
    }
    if (row.status === 'suspended') throw new HttpError(403, 'This account is suspended. Please contact support.');
    this.attempts.delete(key);
    await this.db.run('UPDATE companies SET last_login_at = ?, last_active_at = ? WHERE id = ?', sqlTime(), sqlTime(), row.id);
    return this.publicCompany(row);
  }

  async createSession(companyId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', isoNow());
    await this.db.run('INSERT INTO sessions (token_hash, company_id, expires_at) VALUES (?, ?, ?)', sha256(token), companyId, expires);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  async companyForToken(token) {
    if (!token || token.length > 100) return null;
    const row = await this.db.get(
      `SELECT c.* FROM sessions s JOIN companies c ON c.id = s.company_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND c.status = 'active'`,
      sha256(token),
      isoNow(),
    );
    if (!row) return null;
    // Record activity for the admin analytics, at most every few minutes.
    if (!row.last_active_at || Date.now() - Date.parse(`${row.last_active_at.replace(' ', 'T')}Z`) > ACTIVITY_WRITE_EVERY_MS) {
      await this.db.run('UPDATE companies SET last_active_at = ? WHERE id = ?', sqlTime(), row.id);
    }
    return this.publicCompany(row);
  }

  async logout(token) {
    if (token) await this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  async addFeedback(companyId, input) {
    const message = typeof input.message === 'string' ? input.message.trim().slice(0, 5000) : '';
    if (!message) throw new HttpError(400, 'Please write your feedback', { message: 'Feedback is required' });
    await this.db.run('INSERT INTO feedback (company_id, page, message) VALUES (?, ?, ?)', companyId, cleanText(input.page, 200), message);
  }

  async listFeedback() {
    return this.db.all(
      `SELECT f.id, f.created_at, f.page, f.message, f.resolved, c.id AS company_id, c.company_name, c.manager_name, c.phone
       FROM feedback f LEFT JOIN companies c ON c.id = f.company_id ORDER BY f.id DESC LIMIT 500`,
    );
  }

  async listCompanies() {
    return this.db.all(
      'SELECT id, company_name, manager_name, phone, status, created_at, last_login_at, last_active_at FROM companies ORDER BY id DESC',
    );
  }

  // ---------- developer admin ----------

  adminEnabled() {
    return Boolean(this.adminPassword);
  }

  async adminLogin(password, clientKey) {
    if (!this.adminEnabled()) throw new HttpError(404, 'Not found');
    const key = `admin|${clientKey}`;
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
    if (!safeEqual(password, this.adminPassword)) {
      recent.push(now);
      this.attempts.set(key, recent);
      throw new HttpError(401, 'Wrong admin password');
    }
    this.attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    await this.db.run('DELETE FROM admin_sessions WHERE expires_at < ?', isoNow());
    await this.db.run(
      'INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)',
      sha256(token),
      new Date(now + ADMIN_SESSION_HOURS * 3600000).toISOString(),
    );
    await this.log('admin_login', '');
    return { token, maxAge: ADMIN_SESSION_HOURS * 3600 };
  }

  async isAdmin(token) {
    if (!this.adminEnabled() || !token || token.length > 100) return false;
    return Boolean(await this.db.get('SELECT 1 AS x FROM admin_sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), isoNow()));
  }

  async adminLogout(token) {
    if (token) await this.db.run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
  }

  async log(action, detail) {
    await this.db.run('INSERT INTO admin_log (action, detail) VALUES (?, ?)', action, String(detail).slice(0, 500));
  }

  // Usage figures for one company, read from its own database.
  async companyStats(companyId) {
    return this.withTenant(companyId, async (db) => {
      const n = async (sql, ...p) => Number((await db.get(sql, ...p)).n) || 0;
      return {
        properties: await n('SELECT COUNT(*) AS n FROM properties'),
        tenants: await n("SELECT COUNT(*) AS n FROM tenants WHERE status = 'Active'"),
        agreements: await n("SELECT COUNT(*) AS n FROM agreements WHERE status = 'Active'"),
        beds: await n('SELECT COUNT(*) AS n FROM beds'),
        occupied_beds: await n(
          "SELECT COUNT(*) AS n FROM beds b WHERE EXISTS (SELECT 1 FROM tenants x WHERE x.bed_id = b.id AND x.status = 'Active')",
        ),
        documents: await n('SELECT COUNT(*) AS n FROM documents'),
        rent_collected_this_month: await n('SELECT COALESCE(SUM(amount), 0) AS n FROM rent_payments WHERE period = ?', localToday().slice(0, 7)),
      };
    });
  }

  async analytics() {
    const companies = await this.listCompanies();
    const now = Date.now();
    const daysAgo = (t) => (t ? (now - Date.parse(`${t.replace(' ', 'T')}Z`)) / 86400000 : Infinity);

    const rows = [];
    for (const c of companies) {
      let stats = null;
      try {
        stats = await this.companyStats(c.id);
      } catch (err) {
        stats = { error: err.message };
      }
      rows.push({ ...c, id: Number(c.id), stats });
    }

    const totals = {};
    for (const key of ['properties', 'tenants', 'agreements', 'beds', 'occupied_beds', 'documents', 'rent_collected_this_month']) {
      totals[key] = rows.reduce((sum, r) => sum + (Number(r.stats?.[key]) || 0), 0);
    }

    // Sign-ups per day for the last 30 days (UTC).
    const signups = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
      signups.push({ day, count: companies.filter((c) => String(c.created_at).slice(0, 10) === day).length });
    }

    const feedbackOpen = Number((await this.db.get('SELECT COUNT(*) AS n FROM feedback WHERE resolved = 0')).n);
    return {
      storage: this.storage,
      companies: {
        total: companies.length,
        active_7d: companies.filter((c) => daysAgo(c.last_active_at) <= 7).length,
        new_7d: companies.filter((c) => daysAgo(c.created_at) <= 7).length,
        new_30d: companies.filter((c) => daysAgo(c.created_at) <= 30).length,
        suspended: companies.filter((c) => c.status === 'suspended').length,
      },
      totals,
      signups,
      feedback_open: feedbackOpen,
      rows,
    };
  }

  async setCompanyStatus(companyId, status) {
    const row = await this.requireCompany(companyId);
    await this.db.run('UPDATE companies SET status = ? WHERE id = ?', status, row.id);
    if (status === 'suspended') await this.db.run('DELETE FROM sessions WHERE company_id = ?', row.id);
    await this.log(status === 'suspended' ? 'suspend_company' : 'activate_company', `${row.company_name} (#${row.id})`);
  }

  async resetPassword(companyId, password) {
    const row = await this.requireCompany(companyId);
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpError(400, 'Password must be at least 8 characters', { password: 'At least 8 characters' });
    }
    await this.db.run('UPDATE companies SET password_hash = ? WHERE id = ?', hashPassword(password), row.id);
    await this.db.run('DELETE FROM sessions WHERE company_id = ?', row.id);
    await this.log('reset_password', `${row.company_name} (#${row.id})`);
  }

  async signOutCompany(companyId) {
    const row = await this.requireCompany(companyId);
    const { changes } = await this.db.run('DELETE FROM sessions WHERE company_id = ?', row.id);
    await this.log('sign_out_company', `${row.company_name} (#${row.id}), ${changes} session(s)`);
    return changes;
  }

  async exportCompany(companyId) {
    const row = await this.requireCompany(companyId);
    const data = await this.withTenant(row.id, async (db) => {
      const out = {};
      for (const name of Object.keys(resources)) out[name] = await db.all(`SELECT * FROM ${name} ORDER BY id`);
      return out;
    });
    await this.log('export_company', `${row.company_name} (#${row.id})`);
    return { company: this.publicCompany(row), exported_at: isoNow(), data };
  }

  async deleteCompany(companyId, confirmName) {
    const row = await this.requireCompany(companyId);
    if (confirmName !== row.company_name) {
      throw new HttpError(400, 'Type the company name exactly to confirm', { confirm: 'Company name does not match' });
    }
    if (this.storage === 'postgres') {
      await this.db.exec(`DROP SCHEMA IF EXISTS company_${Number(row.id)} CASCADE`);
      this.readyTenants.delete(Number(row.id));
    } else {
      const tenant = this.tenants.get(Number(row.id));
      if (tenant) {
        await tenant.db.close();
        this.tenants.delete(Number(row.id));
      }
      fs.rmSync(path.join(this.dataDir, 'companies', String(Number(row.id))), { recursive: true, force: true });
    }
    await this.db.run('DELETE FROM companies WHERE id = ?', row.id);
    await this.log('delete_company', `${row.company_name} (#${row.id}, ${row.phone})`);
  }

  async updateSettings(input) {
    const current = await this.settings();
    const next = { ...current };
    if (input.signups_open !== undefined) next.signups_open = input.signups_open ? '1' : '0';
    if (input.read_only !== undefined) next.read_only = input.read_only ? '1' : '0';
    if (input.invite_code !== undefined) next.invite_code = cleanText(input.invite_code, 100);
    if (input.notice !== undefined) next.notice = cleanText(input.notice, 300);
    for (const [key, value] of Object.entries(next)) {
      if (value === current[key]) continue;
      await this.db.run('DELETE FROM settings WHERE key = ?', key);
      await this.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
      await this.log('setting', `${key} = ${key === 'invite_code' && value ? '(set)' : JSON.stringify(value)}`);
    }
    return next;
  }

  async setFeedbackResolved(id, resolved) {
    await this.db.run('UPDATE feedback SET resolved = ? WHERE id = ?', resolved ? 1 : 0, Number(id));
  }

  async adminLogEntries() {
    return this.db.all('SELECT id, action, detail, created_at FROM admin_log ORDER BY id DESC LIMIT 100');
  }

  async requireCompany(companyId) {
    const row = await this.db.get('SELECT * FROM companies WHERE id = ?', Number(companyId));
    if (!row) throw new HttpError(404, 'Company not found');
    return row;
  }
}

module.exports = { Platform, hashPassword, verifyPassword, normalizePhone };
