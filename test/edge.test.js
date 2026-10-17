'use strict';

// The Supabase Edge Function handler (src/edge/handler.js), run in Node.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEdgeHandler } = require('../src/edge/handler');
const { createTestDatabase } = require('./helpers');

const ORIGIN = 'https://neofinn.github.io';
let handle;
let testDb;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-edge-'));
  testDb = await createTestDatabase();
  handle = createEdgeHandler({ dataDir, databaseUrl: testDb.url, adminPassword: 'edge-admin-pass', allowedOrigins: [ORIGIN] });
  await handle.ready;
});

after(async () => {
  await handle.close();
  await testDb.drop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, route, { body, session, admin } = {}) {
  const headers = { Origin: ORIGIN, 'X-Requested-With': 'fetch' };
  if (body) headers['Content-Type'] = 'application/json';
  if (session) headers['X-Session'] = session;
  if (admin) headers['X-Admin-Session'] = admin;
  // Supabase passes the function name as the first path segment: /api/<route>.
  const res = await handle(new Request(`https://example.supabase.co/api${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

test('CORS preflight and headers', async () => {
  const pre = await handle(new Request('https://example.supabase.co/api/auth/login', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-session/);
  const res = await call('GET', '/auth/config');
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('sign up, use the API with a header token, files, logout', async () => {
  const signup = await call('POST', '/auth/signup', { body: { company_name: 'Edge Co', manager_name: 'Eva', phone: '9000000501', password: 'password123' } });
  assert.equal(signup.status, 201);
  const session = signup.body.token;
  assert.ok(session && session.length > 20);

  assert.equal((await call('GET', '/properties')).status, 401);
  assert.equal((await call('GET', '/auth/me', { session })).body.company.company_name, 'Edge Co');
  assert.equal((await call('POST', '/sample-data', { session })).status, 201);
  assert.equal((await call('GET', '/dashboard', { session })).body.counts.properties, 5);

  const doc = await call('POST', '/documents', {
    session,
    body: { title: 'ID', file: { name: 'id.pdf', type: 'application/pdf', data: Buffer.from('%PDF edge').toString('base64') } },
  });
  assert.equal(doc.status, 201);
  const file = await call('GET', doc.body.file_url.replace(/^\/api/, ''), { session });
  assert.equal(file.body, '%PDF edge');
  assert.match(file.headers.get('content-disposition'), /attachment/);

  const csv = await call('GET', '/properties/export.csv', { session });
  assert.match(csv.body, /^id,name,type/);

  // Writes need the X-Requested-With header.
  const bare = await handle(new Request('https://example.supabase.co/api/contacts', { method: 'POST', headers: { 'X-Session': session }, body: '{}' }));
  assert.equal(bare.status, 403);

  assert.equal((await call('POST', '/auth/logout', { session })).status, 200);
  assert.equal((await call('GET', '/auth/me', { session })).status, 401);
  const login = await call('POST', '/auth/login', { body: { phone: '9000000501', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('admin area over header tokens', async () => {
  assert.equal((await call('GET', '/admin/analytics')).status, 401);
  const login = await call('POST', '/admin/login', { body: { password: 'edge-admin-pass' } });
  assert.equal(login.status, 200);
  const admin = login.body.token;
  const stats = (await call('GET', '/admin/analytics', { admin })).body;
  assert.equal(stats.companies.total, 1);
  assert.equal(stats.totals.properties, 5);
  const exported = await call('GET', `/admin/companies/${stats.rows[0].id}/export`, { admin });
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  await call('POST', '/admin/logout', { admin });
  assert.equal((await call('GET', '/admin/analytics', { admin })).status, 401);
});
