'use strict';

// With TEST_DATABASE_URL (a Postgres server, e.g. postgres://postgres:pw@localhost:5432/postgres)
// each call creates a throwaway database; without it the tests use SQLite.
async function createTestDatabase() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return { url: '', drop: async () => {} };
  const { Client } = require('pg');
  const name = `pm_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const c = new Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

module.exports = { createTestDatabase };
