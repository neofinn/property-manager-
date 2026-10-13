'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { resources } = require('./schema');

const SQL_TYPES = {
  number: 'INTEGER',
  money: 'REAL',
  bool: 'INTEGER',
  ref: 'INTEGER',
};

// A `file` field is stored as four columns.
const FILE_COLUMNS = ['name', 'stored', 'mime', 'size'];

function columnsFor(field) {
  if (field.type === 'file') {
    return FILE_COLUMNS.map((suffix) => ({
      name: `${field.name}_${suffix}`,
      sql: `${field.name}_${suffix} ${suffix === 'size' ? 'INTEGER' : 'TEXT'}`,
    }));
  }
  let sql = `${field.name} ${SQL_TYPES[field.type] || 'TEXT'}`;
  if (field.required) sql += ' NOT NULL';
  if (field.type === 'ref') {
    sql += ` REFERENCES ${field.ref}(id) ON DELETE ${field.onDelete || 'SET NULL'}`;
  }
  return [{ name: field.name, sql }];
}

function createTableSql(name, def) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
  for (const field of def.fields) {
    for (const col of columnsFor(field)) cols.push(col.sql);
  }
  cols.push("created_at TEXT NOT NULL DEFAULT (datetime('now'))");
  cols.push("updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
  return `CREATE TABLE IF NOT EXISTS ${name} (\n  ${cols.join(',\n  ')}\n)`;
}

function open(dataDir) {
  const inMemory = dataDir === ':memory:';
  if (!inMemory) fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(inMemory ? ':memory:' : path.join(dataDir, 'crm.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');

  for (const [name, def] of Object.entries(resources)) {
    db.exec(createTableSql(name, def));
    // Add columns introduced after the table was first created.
    const existing = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    for (const field of def.fields) {
      for (const col of columnsFor(field)) {
        if (!existing.has(col.name)) {
          // SQLite cannot add NOT NULL columns without a default, so relax it.
          db.exec(`ALTER TABLE ${name} ADD COLUMN ${col.sql.replace(' NOT NULL', '')}`);
        }
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS reminder_log_key ON reminder_log(reminder_key);
    CREATE INDEX IF NOT EXISTS rent_payments_agreement ON rent_payments(agreement_id, period);
    CREATE INDEX IF NOT EXISTS bills_due ON bills(status, due_date);
    CREATE INDEX IF NOT EXISTS schedules_start ON schedules(starts_at);
  `);

  return db;
}

module.exports = { open, columnsFor, FILE_COLUMNS };
