'use strict';

// Postgres (e.g. Supabase) backend with the same async interface as
// SqliteDatabase. Platform tables live in the `public` schema; each company's
// CRM tables live in their own schema (company_<id>), so the CRM queries are
// identical on every backend and one company can never read another's rows.

const { postgres } = require('./dialect');

// `?` placeholders -> `$1, $2, …` (none of our SQL has a literal "?").
function numbered(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// `searchPath` (e.g. 'pgm') keeps an app's platform tables in their own schema,
// so two apps can share one database.
function createPool(connectionString, { poolSize, searchPath } = {}) {
  const pg = require('pg');
  // Counts and sums come back as int8/numeric strings; the app expects numbers.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: poolSize || Number(process.env.DATABASE_POOL_SIZE) || 10,
    idleTimeoutMillis: 30000,
    // Supabase requires TLS; its certificate chain is not in Node's default store.
    ssl: local || /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  if (searchPath) {
    if (!/^[a-z_][a-z0-9_]*$/.test(searchPath)) throw new Error(`Bad schema name: ${searchPath}`);
    pool.basePath = searchPath;
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${searchPath}`).catch((err) => console.error('search_path:', err.message));
    });
  }
  return pool;
}

class PostgresDatabase {
  // `client` is a pool (platform tables) or one checked-out client (a request).
  constructor(client) {
    this.client = client;
    this.dialect = postgres;
    this.depth = 0;
  }

  async query(sql, params) {
    return this.client.query(numbered(sql), params.map((v) => (v === undefined ? null : v)));
  }

  async all(sql, ...params) {
    return (await this.query(sql, params)).rows;
  }

  async get(sql, ...params) {
    return (await this.query(sql, params)).rows[0];
  }

  async run(sql, ...params) {
    return { changes: (await this.query(sql, params)).rowCount };
  }

  async insert(sql, ...params) {
    return Number((await this.query(`${sql} RETURNING id`, params)).rows[0].id);
  }

  async exec(sql) {
    await this.client.query(sql);
  }

  // Only valid on a checked-out client (inside withSchema). Nested calls join.
  async transaction(fn) {
    if (this.depth > 0) return fn(this);
    this.depth++;
    await this.client.query('BEGIN');
    try {
      const result = await fn(this);
      await this.client.query('COMMIT');
      return result;
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      this.depth--;
    }
  }
}

// Runs `fn(db)` on one connection whose search_path is `schema`.
// Needs a session-mode connection (Supabase "Session pooler" or direct).
async function withSchema(pool, schema, fn) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}; SET search_path TO ${schema}`);
    return await fn(new PostgresDatabase(client));
  } finally {
    await client.query(pool.basePath ? `SET search_path TO ${pool.basePath}` : 'RESET search_path').catch(() => {});
    client.release();
  }
}

module.exports = { PostgresDatabase, createPool, withSchema };
