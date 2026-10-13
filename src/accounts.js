'use strict';

// Company accounts, login sessions and beta feedback. Each company's CRM data
// lives in its own database (see tenants in app.js); this database only holds
// who can log in.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { HttpError } = require('./store');

const SESSION_DAYS = 30;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// "+91 98765-43210" -> "+919876543210". A bare 10-digit number gets the default country code.
function normalizePhone(raw, defaultCountryCode) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  let digits = s.replace(/\D/g, '');
  if (!s.startsWith('+')) {
    digits = digits.replace(/^0+/, '');
    if (digits.length === 10 && defaultCountryCode) digits = `${defaultCountryCode}${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

class Accounts {
  constructor(dataDir, { defaultCountryCode = '91', inviteCode = '' } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'accounts.sqlite'));
    this.defaultCountryCode = defaultCountryCode;
    this.inviteCode = inviteCode;
    this.attempts = new Map();
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL,
        manager_name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        page TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close() {
    this.db.close();
  }

  publicCompany(row) {
    return { id: row.id, company_name: row.company_name, manager_name: row.manager_name, phone: row.phone, created_at: row.created_at };
  }

  signup(input) {
    const errors = {};
    const company_name = cleanText(input.company_name, 120);
    const manager_name = cleanText(input.manager_name, 120);
    const phone = normalizePhone(input.phone, this.defaultCountryCode);
    const password = typeof input.password === 'string' ? input.password : '';

    if (company_name.length < 2) errors.company_name = 'Company name is required';
    if (manager_name.length < 2) errors.manager_name = 'Manager name is required';
    if (!phone) errors.phone = 'Enter a valid phone number';
    if (password.length < 8) errors.password = 'Password must be at least 8 characters';
    else if (password.length > 200) errors.password = 'Password is too long';
    if (this.inviteCode && cleanText(input.invite_code, 100) !== this.inviteCode) {
      errors.invite_code = 'Invite code is not valid';
    }
    if (phone && this.db.prepare('SELECT 1 FROM companies WHERE phone = ?').get(phone)) {
      errors.phone = 'An account with this phone number already exists. Please log in.';
    }
    if (Object.keys(errors).length) throw new HttpError(400, 'Please fix the highlighted fields', errors);

    const result = this.db
      .prepare('INSERT INTO companies (company_name, manager_name, phone, password_hash) VALUES (?, ?, ?, ?)')
      .run(company_name, manager_name, phone, hashPassword(password));
    return this.publicCompany(this.db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid));
  }

  login(phoneInput, password, clientKey) {
    const phone = normalizePhone(phoneInput, this.defaultCountryCode);
    const key = `${clientKey}|${phone}`;
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes and try again.');
    }

    const row = phone ? this.db.prepare('SELECT * FROM companies WHERE phone = ?').get(phone) : null;
    const ok = verifyPassword(typeof password === 'string' ? password : '', row ? row.password_hash : DUMMY_HASH) && row;
    if (!ok) {
      recent.push(now);
      this.attempts.set(key, recent);
      throw new HttpError(401, 'Phone number or password is incorrect');
    }
    this.attempts.delete(key);
    this.db.prepare("UPDATE companies SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
    return this.publicCompany(row);
  }

  createSession(companyId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    this.db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
    this.db.prepare('INSERT INTO sessions (token_hash, company_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), companyId, expires);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  companyForToken(token) {
    if (!token || token.length > 100) return null;
    const row = this.db
      .prepare(
        `SELECT c.* FROM sessions s JOIN companies c ON c.id = s.company_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), new Date().toISOString());
    return row ? this.publicCompany(row) : null;
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  addFeedback(companyId, input) {
    const message = typeof input.message === 'string' ? input.message.trim().slice(0, 5000) : '';
    if (!message) throw new HttpError(400, 'Please write your feedback', { message: 'Feedback is required' });
    this.db.prepare('INSERT INTO feedback (company_id, page, message) VALUES (?, ?, ?)').run(companyId, cleanText(input.page, 200), message);
  }

  listFeedback() {
    return this.db
      .prepare(
        `SELECT f.id, f.created_at, f.page, f.message, c.company_name, c.manager_name, c.phone
         FROM feedback f LEFT JOIN companies c ON c.id = f.company_id ORDER BY f.id DESC`,
      )
      .all();
  }
}

module.exports = { Accounts, normalizePhone, hashPassword, verifyPassword };
