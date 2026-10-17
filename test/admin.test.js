'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const { createTestDatabase } = require('./helpers');

let server;
let base;
let app;
let dataDir;
let testDb;
let adminCookie = '';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-admin-'));
  testDb = await createTestDatabase();
  app = createApp({ dataDir, databaseUrl: testDb.url, adminPassword: 'admin-secret-1' });
  await app.ready;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await app.close();
  await testDb.drop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie = '') {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

const admin = (method, url, body) => call(method, `/api/admin${url}`, body, adminCookie);

async function signup(company_name, phone) {
  const res = await call('POST', '/api/auth/signup', { company_name, manager_name: 'Manager', phone, password: 'password123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { company: res.body.company, cookie: res.headers.get('set-cookie').split(';')[0] };
}

test('admin area is off without ADMIN_PASSWORD', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-noadmin-'));
  const plainDb = await createTestDatabase();
  const plain = createApp({ dataDir: dir, databaseUrl: plainDb.url });
  const srv = http.createServer(plain);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const port = srv.address().port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/analytics`)).status, 404);
  } finally {
    srv.close();
    await plain.close();
    await plainDb.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin login', async () => {
  assert.equal((await call('GET', '/admin')).status, 200);
  assert.equal((await call('GET', '/api/admin/analytics')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const res = await call('POST', '/api/admin/login', { password: 'admin-secret-1' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /pm_admin=.+HttpOnly; SameSite=Strict/);
  adminCookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await admin('GET', '/me')).status, 200);
});

test('analytics across companies', async () => {
  const a = await signup('Alpha Homes', '9000000001');
  await signup('Beta Hostels', '9000000002');
  assert.equal((await call('POST', '/api/sample-data', null, a.cookie)).status, 201);

  const stats = (await admin('GET', '/analytics')).body;
  assert.equal(stats.companies.total, 2);
  assert.equal(stats.companies.new_7d, 2);
  assert.equal(stats.signups.length, 30);
  assert.equal(stats.signups.at(-1).count, 2);
  const alpha = stats.rows.find((r) => r.company_name === 'Alpha Homes');
  assert.equal(alpha.stats.pgs, 2);
  assert.equal(alpha.stats.beds, 20);
  assert.equal(stats.totals.pgs, 2);
  assert.equal(alpha.password_hash, undefined, 'no password hashes in analytics');
});

test('platform settings: closing sign-ups, invite code, maintenance mode', async () => {
  const user = await signup('Gamma Rentals', '9000000003');

  await admin('PATCH', '/settings', { signups_open: false });
  assert.equal((await call('POST', '/api/auth/signup', { company_name: 'Late Co', manager_name: 'L', phone: '9000000009', password: 'password123' })).status, 403);
  await admin('PATCH', '/settings', { signups_open: true, invite_code: 'SECRET1' });
  assert.equal((await call('GET', '/api/auth/config')).body.inviteRequired, true);
  const noCode = await call('POST', '/api/auth/signup', { company_name: 'Late Co', manager_name: 'L', phone: '9000000009', password: 'password123' });
  assert.ok(noCode.body.details.invite_code);
  await admin('PATCH', '/settings', { invite_code: '' });

  await admin('PATCH', '/settings', { read_only: true, notice: 'Upgrading the database, back in 10 minutes' });
  const cfg = (await call('GET', '/api/config', null, user.cookie)).body;
  assert.equal(cfg.readOnly, true);
  assert.match(cfg.notice, /Upgrading/);
  assert.equal((await call('GET', '/api/pgs', null, user.cookie)).status, 200, 'reads still work');
  const blocked = await call('POST', '/api/contacts', { name: 'X' }, user.cookie);
  assert.equal(blocked.status, 503);
  assert.match(blocked.body.error, /Upgrading/);
  await admin('PATCH', '/settings', { read_only: false, notice: '' });
  assert.equal((await call('POST', '/api/contacts', { name: 'X' }, user.cookie)).status, 201);
});

test('company controls: suspend, reset password, sign out, export, delete', async () => {
  const user = await signup('Delta Stays', '9000000004');
  const id = user.company.id;
  await call('POST', '/api/pgs', { name: 'Delta PG', address: 'Road 1' }, user.cookie);

  await admin('POST', `/companies/${id}/suspend`);
  assert.equal((await call('GET', '/api/config', null, user.cookie)).status, 401, 'suspension signs the company out');
  assert.equal((await call('POST', '/api/auth/login', { phone: '9000000004', password: 'password123' })).status, 403);
  await admin('POST', `/companies/${id}/activate`);

  assert.equal((await admin('POST', `/companies/${id}/reset-password`, { password: 'short' })).status, 400);
  await admin('POST', `/companies/${id}/reset-password`, { password: 'new-password-9' });
  assert.equal((await call('POST', '/api/auth/login', { phone: '9000000004', password: 'password123' })).status, 401);
  const login = await call('POST', '/api/auth/login', { phone: '9000000004', password: 'new-password-9' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  assert.equal((await admin('POST', `/companies/${id}/sign-out`)).body.sessions, 1);
  assert.equal((await call('GET', '/api/config', null, cookie)).status, 401);

  const exported = await admin('GET', `/companies/${id}/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal(exported.body.data.pgs[0].name, 'Delta PG');

  assert.equal((await admin('DELETE', `/companies/${id}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await admin('DELETE', `/companies/${id}`, { confirm: 'Delta Stays' })).status, 200);
  assert.ok(!(await admin('GET', '/analytics')).body.rows.some((r) => r.id === id));
  assert.equal((await call('POST', '/api/auth/login', { phone: '9000000004', password: 'new-password-9' })).status, 401);

  const log = (await admin('GET', '/log')).body.map((e) => e.action);
  for (const action of ['suspend_company', 'activate_company', 'reset_password', 'sign_out_company', 'export_company', 'delete_company']) {
    assert.ok(log.includes(action), `${action} is in the admin log`);
  }
});

test('feedback inbox', async () => {
  const user = await signup('Echo Estates', '9000000005');
  await call('POST', '/api/feedback', { message: 'Please add a bookings calendar', page: '#/bedboard' }, user.cookie);
  const items = (await admin('GET', '/feedback')).body;
  const item = items.find((f) => f.message.includes('bookings'));
  assert.equal(item.company_name, 'Echo Estates');
  assert.equal(item.resolved, 0);
  await admin('PATCH', `/feedback/${item.id}`, { resolved: true });
  assert.equal((await admin('GET', '/feedback')).body.find((f) => f.id === item.id).resolved, 1);
  assert.equal((await admin('GET', '/analytics')).body.feedback_open, 0);
});

test('admin logout and CSRF header', async () => {
  const noHeader = await fetch(`${base}/api/admin/settings`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ signups_open: false }),
  });
  assert.equal(noHeader.status, 403);
  await admin('POST', '/logout');
  assert.equal((await admin('GET', '/analytics')).status, 401);
});
