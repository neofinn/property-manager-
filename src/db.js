'use strict';

// Creates and migrates one company's CRM tables on any backend in
// src/database (SQLite file, sql.js in the browser, or a Postgres schema).

const { resources } = require('./schema');

// A `file` field is stored as four columns.
const FILE_COLUMNS = ['name', 'stored', 'mime', 'size'];

function columnsFor(field, dialect) {
  if (field.type === 'file') {
    return FILE_COLUMNS.map((suffix) => ({
      name: `${field.name}_${suffix}`,
      sql: `${field.name}_${suffix} ${suffix === 'size' ? 'INTEGER' : 'TEXT'}`,
    }));
  }
  const type = { number: 'INTEGER', money: dialect.money, bool: 'INTEGER', ref: 'BIGINT' }[field.type] || 'TEXT';
  let sql = `${field.name} ${type}`;
  if (field.required) sql += ' NOT NULL';
  if (field.type === 'ref') sql += ` REFERENCES ${field.ref}(id) ON DELETE ${field.onDelete || 'SET NULL'}`;
  return [{ name: field.name, sql }];
}

function createTableSql(name, def, dialect) {
  const cols = [dialect.idColumn];
  for (const field of def.fields) for (const col of columnsFor(field, dialect)) cols.push(col.sql);
  cols.push(`created_at TEXT NOT NULL DEFAULT (${dialect.now})`);
  cols.push(`updated_at TEXT NOT NULL DEFAULT (${dialect.now})`);
  return `CREATE TABLE IF NOT EXISTS ${name} (\n  ${cols.join(',\n  ')}\n)`;
}

// Postgres needs a referenced table to exist first.
function tablesInDependencyOrder() {
  const order = [];
  const visit = (name, seen = new Set()) => {
    if (order.includes(name) || seen.has(name)) return;
    seen.add(name);
    for (const f of resources[name].fields) if (f.type === 'ref' && f.ref !== name) visit(f.ref, seen);
    order.push(name);
  };
  Object.keys(resources).forEach((name) => visit(name));
  return order;
}

async function initSchema(db) {
  const { dialect } = db;
  for (const name of tablesInDependencyOrder()) {
    const def = resources[name];
    await db.exec(createTableSql(name, def, dialect));
    // Add columns introduced after the table was first created.
    const q = dialect.columnsSql(name);
    const existing = new Set((await db.all(q.sql, ...q.params)).map((c) => c.name));
    for (const field of def.fields) {
      for (const col of columnsFor(field, dialect)) {
        if (!existing.has(col.name)) {
          // A NOT NULL column can't be added to a table that has rows, so relax it.
          await db.exec(`ALTER TABLE ${name} ADD COLUMN ${col.sql.replace(' NOT NULL', '')}`);
        }
      }
    }
  }

  // Data migrations for renamed options.
  await db.run("UPDATE properties SET type = 'PG / Hostel' WHERE type = 'PG'");
  const q = dialect.columnsSql('properties');
  if ((await db.all(q.sql, ...q.params)).some((c) => c.name === 'food_included')) {
    await db.run("UPDATE properties SET meals = 'All 3 meals' WHERE food_included = 1 AND meals IS NULL");
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      ${dialect.idColumn},
      reminder_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (${dialect.now})
    );
    CREATE TABLE IF NOT EXISTS files (stored TEXT PRIMARY KEY, data ${dialect.blob} NOT NULL);
    CREATE INDEX IF NOT EXISTS reminder_log_key ON reminder_log(reminder_key);
    CREATE INDEX IF NOT EXISTS rent_payments_agreement ON rent_payments(agreement_id, period);
    CREATE INDEX IF NOT EXISTS bills_due ON bills(status, due_date);
    CREATE INDEX IF NOT EXISTS schedules_start ON schedules(starts_at);
  `);
  return db;
}

module.exports = { initSchema, columnsFor, FILE_COLUMNS };
