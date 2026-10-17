'use strict';

// Wraps a sql.js database in the small part of the node:sqlite API that the
// store uses: exec(sql) and prepare(sql).all/get/run(...params).

function bindable(params) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
}

class SqlJsDatabase {
  constructor(SQL, bytes) {
    this.raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    const raw = this.raw;
    const all = (...params) => {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(bindable(params));
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    };
    return {
      all,
      get: (...params) => all(...params)[0],
      run: (...params) => {
        raw.run(sql, bindable(params));
        const changes = raw.getRowsModified();
        const lastInsertRowid = raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid };
      },
    };
  }

  // Exporting reopens the database, which resets connection settings.
  export() {
    const bytes = this.raw.export();
    this.raw.exec('PRAGMA foreign_keys = ON');
    return bytes;
  }

  close() {
    this.raw.close();
  }
}

module.exports = { SqlJsDatabase };
