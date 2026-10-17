'use strict';

// Async database interface over a synchronous SQLite handle (node:sqlite on
// the server, sql.js in the browser demo). Every backend offers:
//   all(sql, ...params) -> rows      get(sql, ...params) -> row | undefined
//   run(sql, ...params) -> { changes }
//   insert(sql, ...params) -> new row id
//   exec(sql)                        transaction(async (db) => ...)
//   dialect                          (see ./dialect.js)
// SQL uses `?` placeholders on every backend.

const { sqlite } = require('./dialect');

class SqliteDatabase {
  // `handle` has the node:sqlite shape: exec(sql), prepare(sql).all/get/run.
  constructor(handle) {
    this.handle = handle;
    this.dialect = sqlite;
    this.depth = 0;
    // SQLite leaves foreign keys off unless asked, per connection.
    handle.exec('PRAGMA foreign_keys = ON');
  }

  static open(file) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new SqliteDatabase(new DatabaseSync(file));
    if (file !== ':memory:') db.handle.exec('PRAGMA journal_mode = WAL');
    return db;
  }

  async all(sql, ...params) {
    return this.handle.prepare(sql).all(...params);
  }

  async get(sql, ...params) {
    return this.handle.prepare(sql).get(...params);
  }

  async run(sql, ...params) {
    const { changes } = this.handle.prepare(sql).run(...params);
    return { changes: Number(changes) };
  }

  async insert(sql, ...params) {
    return Number(this.handle.prepare(sql).run(...params).lastInsertRowid);
  }

  async exec(sql) {
    this.handle.exec(sql);
  }

  // Nested calls join the outer transaction.
  async transaction(fn) {
    if (this.depth > 0) return fn(this);
    this.depth++;
    this.handle.exec('BEGIN');
    try {
      const result = await fn(this);
      this.handle.exec('COMMIT');
      return result;
    } catch (err) {
      this.handle.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  async close() {
    this.handle.close();
  }
}

module.exports = { SqliteDatabase };
