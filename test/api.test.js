'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const { createTestDatabase } = require('./helpers');
const { dueDateFor } = require('../src/reminders');

let server;
let base;
let app;
let dataDir;
let cookie = '';
let testDb;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  // With TEST_DATABASE_URL set, the suite runs against a fresh Postgres database.
  testDb = await createTestDatabase();
  app = createApp({ dataDir, databaseUrl: testDb.url, adminPassword: 'admin-secret-1' });
  await app.ready;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('POST', '/api/auth/signup', { company_name: 'Test Co', manager_name: 'Tess Manager', phone: '9876543210', password: 'password123' });
  assert.equal(res.status, 201);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  server.close();
  await app.close();
  await testDb.drop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, { auth = cookie, redirect = 'follow' } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers.Cookie = auth;
  const res = await fetch(base + url, { method, headers, redirect, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

test('serves the app shell', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /PG Manager/);
  assert.equal((await call('GET', '/../package.json')).status, 404);
});

test('validates required fields and types', async () => {
  const res = await call('POST', '/api/pgs', { total_beds: 'abc', pg_for: 'Castle' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.name);
  assert.ok(res.body.details.address);
  assert.ok(res.body.details.total_beds);
  assert.ok(res.body.details.pg_for);
});

test('PG beds come from total beds and qty x rate price lines', async () => {
  const pg = (await call('POST', '/api/pgs', {
    name: 'Lines PG', address: 'L Rd', rent_per_bed: 5000,
    bed_prices: [{ label: '2-sharing AC', beds: '3', price: '9000' }, { label: '', beds: '', price: '' }, { label: '3-sharing', beds: 2, price: 7000.456 }],
  })).body;
  assert.equal(pg.total_beds, 5, 'total beds from the lines');
  assert.deepEqual(pg.bed_prices, [{ label: '2-sharing AC', beds: 3, price: 9000 }, { label: '3-sharing', beds: 2, price: 7000.46 }]);
  let beds = (await call('GET', `/api/beds?pg_id=${pg.id}&sort=id&dir=asc`)).body;
  assert.deepEqual(beds.map((b) => [b.bed_label, b.bed_type, b.rent]), [
    ['B1', '2-sharing AC', 9000], ['B2', '2-sharing AC', 9000], ['B3', '2-sharing AC', 9000], ['B4', '3-sharing', 7000.46], ['B5', '3-sharing', 7000.46],
  ]);

  // More total beds adds beds at the default rate; a new rate updates that type's beds.
  const bad = await call('PATCH', `/api/pgs/${pg.id}`, { total_beds: 4 });
  assert.match(bad.body.details.total_beds, /less than the 5 beds/);
  await call('PATCH', `/api/pgs/${pg.id}`, { total_beds: 7, bed_prices: [{ label: '2-sharing AC', beds: 3, price: 9500 }, { label: '3-sharing', beds: 2, price: 7000 }] });
  beds = (await call('GET', `/api/beds?pg_id=${pg.id}&sort=id&dir=asc`)).body;
  assert.equal(beds.length, 7);
  assert.deepEqual(beds.slice(5).map((b) => [b.bed_label, b.bed_type, b.rent]), [['B6', null, 5000], ['B7', null, 5000]]);
  assert.equal(beds[0].rent, 9500);
  const row = (await call('GET', `/api/pgs/${pg.id}`)).body;
  assert.deepEqual([row.bed_count, row.occupied_beds, row.booked_beds], [7, 0, 0]);
  assert.match((await call('GET', `/api/pgs/export.csv?q=Lines`)).body, /2-sharing AC \(3 beds\): 9500/);
});

test('guests: bed links PG and rent, one guest per bed, check-out frees the bed', async () => {
  const pg = (await call('POST', '/api/pgs', { name: 'Guest PG', address: 'G Rd', bed_prices: [{ label: 'Single', beds: 2, price: 12000 }] })).body;
  const other = (await call('POST', '/api/pgs', { name: 'Other PG', address: 'O Rd', total_beds: 1 })).body;
  const [b1, b2] = (await call('GET', `/api/beds?pg_id=${pg.id}&sort=id&dir=asc`)).body;

  const g1 = await call('POST', '/api/guests', { full_name: 'Asha', phone: '+91 90000 00001', bed_id: b1.id, check_in: '2026-09-12' });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.pg_id, pg.id, 'bed fills in the PG');
  assert.equal(g1.body.rent, 12000, 'rent from the bed');
  assert.equal(g1.body.bed_id_label, `B1 · Guest PG`);
  assert.equal(g1.body.status, 'Active');

  const dup = await call('POST', '/api/guests', { full_name: 'Meera', phone: '1', bed_id: b1.id });
  assert.match(dup.body.details.bed_id, /already occupied by Asha/);
  const wrong = await call('POST', '/api/guests', { full_name: 'Meera', phone: '1', pg_id: other.id, bed_id: b2.id });
  assert.match(wrong.body.details.bed_id, /not in the selected PG/);
  const booked = (await call('POST', '/api/guests', { full_name: 'Meera', phone: '1', bed_id: b2.id, status: 'Booked', check_in: '2026-10-08' })).body;
  assert.match((await call('POST', '/api/guests', { full_name: 'Zoya', phone: '2', bed_id: b2.id })).body.details.bed_id, /booked for Meera/);
  assert.ok((await call('GET', '/api/guests?phone=')).status === 200);

  let bed = (await call('GET', `/api/beds/${b1.id}`)).body;
  assert.deepEqual([bed.guest_name, bed.guest_status], ['Asha', 'Active']);
  let row = (await call('GET', `/api/pgs/${pg.id}`)).body;
  assert.deepEqual([row.occupied_beds, row.booked_beds, row.guest_count], [1, 1, 1]);

  // A bed under maintenance can't take a new guest.
  await call('PATCH', `/api/guests/${booked.id}`, { status: 'Checked out' });
  await call('PATCH', `/api/beds/${b2.id}`, { status: 'Under Maintenance' });
  assert.match((await call('POST', '/api/guests', { full_name: 'Zoya', phone: '2', bed_id: b2.id })).body.details.bed_id, /under maintenance/);

  // Rent reminders: first month on check-in, then on the PG's due day; payments clear them.
  let rem = (await call('GET', '/api/reminders?today=2026-10-07&days=0')).body;
  const mine = rem.rent.filter((r) => r.guest_id === g1.body.id);
  assert.deepEqual(mine.map((r) => [r.period, r.due_date, r.state, r.outstanding]), [['2026-09', '2026-09-12', 'overdue', 12000], ['2026-10', '2026-10-05', 'overdue', 12000]]);
  assert.equal(mine[0].place, 'Guest PG, B1');
  assert.match(mine[0].links.whatsapp, /^https:\/\/wa\.me\/919000000001\?text=/);
  await call('POST', '/api/payments', { guest_id: g1.body.id, period: '2026-09', amount: 12000, paid_on: '2026-09-12' });
  await call('POST', '/api/payments', { guest_id: g1.body.id, kind: 'Deposit', period: '2026-10', amount: 12000, paid_on: '2026-10-01' });
  rem = (await call('GET', '/api/reminders?today=2026-10-07&days=0')).body;
  assert.deepEqual(rem.rent.filter((r) => r.guest_id === g1.body.id).map((r) => r.period), ['2026-10'], 'deposits are not rent');

  // Check-out reminder, then checking out frees the bed and fills the date.
  await call('PATCH', `/api/guests/${g1.body.id}`, { check_out: '2026-10-10' });
  rem = (await call('GET', '/api/reminders?today=2026-10-07')).body;
  assert.ok(rem.stays.some((x) => x.type === 'checkout' && x.guest_id === g1.body.id && x.days_left === 3));
  const out = (await call('PATCH', `/api/guests/${g1.body.id}`, { status: 'Checked out', check_out: null })).body;
  assert.ok(out.check_out, 'check-out date filled in');
  bed = (await call('GET', `/api/beds/${b1.id}`)).body;
  assert.equal(bed.guest_name, null);
  assert.equal((await call('POST', '/api/guests', { full_name: 'Next', phone: '3', bed_id: b1.id })).status, 201, 'bed is free again');

  const dash = (await call('GET', '/api/dashboard')).body;
  assert.ok(dash.beds.total >= 3 && dash.beds.occupied >= 1);
  assert.equal(dash.beds.total, dash.beds.occupied + dash.beds.booked + dash.beds.blocked + dash.beds.vacant);
  const opts = (await call('GET', '/api/beds/options')).body;
  assert.equal(opts.find((o) => o.id === b1.id).parent, pg.id);
  assert.equal(opts.find((o) => o.id === b1.id).occupant, 'Next');
});

test('expenses, search and filter', async () => {
  const pg = (await call('POST', '/api/pgs', { name: 'Hill Top', address: 'Hill Rd' })).body;
  const bill = (await call('POST', '/api/bills', { pg_id: pg.id, category: 'Groceries', amount: 450.456, due_date: '2026-10-01' })).body;
  assert.equal(bill.amount, 450.46);
  assert.equal(bill.status, 'Unpaid');
  let rem = (await call('GET', '/api/reminders?today=2026-10-03')).body;
  assert.equal(rem.bills.find((b) => b.bill_id === bill.id).state, 'overdue');
  const updated = (await call('PATCH', `/api/bills/${bill.id}`, { status: 'Paid', paid_on: '2026-10-03' })).body;
  assert.equal(updated.category, 'Groceries', 'partial update keeps other fields');
  rem = (await call('GET', '/api/reminders?today=2026-10-03')).body;
  assert.ok(!rem.bills.some((b) => b.bill_id === bill.id));
  assert.ok((await call('GET', '/api/bills?q=Hill')).body.some((b) => b.id === bill.id), 'search matches the PG name');
  assert.ok(!(await call('GET', '/api/bills?status=Unpaid')).body.some((b) => b.id === bill.id));
});

test('document upload, download, verification and cleanup', async () => {
  const content = Buffer.from('%PDF-1.4 fake pdf');
  const doc = (await call('POST', '/api/documents', {
    title: 'ID card', doc_type: 'ID Proof', file: { name: 'id card.pdf', type: 'application/pdf', data: content.toString('base64') },
  })).body;
  assert.equal(doc.verified, 0);
  assert.equal(doc.file_name, 'id card.pdf');
  assert.equal(doc.file_stored, undefined, 'internal file name is not exposed');

  const file = await fetch(base + doc.file_url, { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), content);

  const html = (await call('POST', '/api/documents', {
    title: 'evil', file: { name: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') },
  })).body;
  const htmlRes = await fetch(base + html.file_url, { headers: { Cookie: cookie } });
  assert.match(htmlRes.headers.get('content-disposition'), /^attachment/);

  let rem = (await call('GET', '/api/reminders')).body;
  assert.ok(rem.documents_unverified.some((d) => d.document_id === doc.id));
  await call('PATCH', `/api/documents/${doc.id}`, { verified: true, verified_on: '2026-10-01' });
  rem = (await call('GET', '/api/reminders')).body;
  assert.ok(!rem.documents_unverified.some((d) => d.document_id === doc.id));

  const storedFiles = () => app.platform.withTenant(1, async (db) => (await db.get('SELECT COUNT(*) AS n FROM files')).n);
  const before = await storedFiles();
  await call('DELETE', `/api/documents/${doc.id}`);
  assert.equal(await storedFiles(), before - 1);
});

test('CSV export neutralises formulas', async () => {
  await call('POST', '/api/contacts', { name: '=HYPERLINK("x")', category: 'Plumber' });
  const res = await call('GET', '/api/contacts/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.body, /^id,name,category/);
  assert.match(res.body, /"'=HYPERLINK\(""x""\)"/);
});

test('unknown resources and ids are rejected', async () => {
  assert.equal((await call('GET', '/api/users')).status, 404);
  assert.equal((await call('GET', '/api/pgs/abc')).status, 404);
  assert.equal((await call('GET', '/api/pgs/99999')).status, 404);
  assert.equal((await call('GET', '/api/pgs?sort=name;DROP TABLE x')).status, 200);
});

test('due date rules', () => {
  const g = { check_in: '2026-01-20', check_out: '2026-12-10', due_day: 5 };
  assert.equal(dueDateFor(g, '2026-01'), '2026-01-20', 'first month due on check-in');
  assert.equal(dueDateFor({ ...g, due_day: 25 }, '2026-01'), '2026-01-25');
  assert.equal(dueDateFor(g, '2026-02'), '2026-02-05');
  assert.equal(dueDateFor(g, '2026-12'), '2026-12-05');
  assert.equal(dueDateFor(g, '2027-01'), null, 'not due after check-out');
  assert.equal(dueDateFor(g, '2025-12'), null, 'not due before check-in');
});

test('signup validation, login, logout and sessions', async () => {
  const bad = await call('POST', '/api/auth/signup', { company_name: '', manager_name: 'A', phone: '123', password: 'short' }, { auth: '' });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.details).sort(), ['company_name', 'manager_name', 'password', 'phone']);

  const dup = await call('POST', '/api/auth/signup', { company_name: 'X Co', manager_name: 'Xavier', phone: '+91 98765 43210', password: 'password123' }, { auth: '' });
  assert.match(dup.body.details.phone, /already exists/);

  // Not logged in: API is 401, pages redirect to the login page.
  assert.equal((await call('GET', '/api/pgs', null, { auth: '' })).status, 401);
  const page = await call('GET', '/', null, { auth: '', redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.match((await call('GET', '/signup', null, { auth: '' })).body, /Company name/);
  assert.equal((await call('GET', '/login', null, { redirect: 'manual' })).headers.get('location'), '/', 'logged in users skip the login page');

  assert.equal((await call('POST', '/api/auth/login', { phone: '9876543210', password: 'wrong-password' }, { auth: '' })).status, 401);
  const login = await call('POST', '/api/auth/login', { phone: '098765 43210', password: 'password123' }, { auth: '' });
  assert.equal(login.status, 200);
  assert.equal(login.body.company.company_name, 'Test Co');
  assert.equal(login.body.company.password_hash, undefined);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const second = setCookie.split(';')[0];
  assert.equal((await call('GET', '/api/auth/me', null, { auth: second })).body.company.manager_name, 'Tess Manager');

  await call('POST', '/api/auth/logout', null, { auth: second });
  assert.equal((await call('GET', '/api/auth/me', null, { auth: second })).status, 401);
  assert.equal((await call('GET', '/api/auth/me')).status, 200, 'other sessions stay logged in');

  // Writes without the X-Requested-With header are refused (CSRF protection).
  const csrf = await fetch(`${base}/api/pgs`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);
});

test('each company only sees its own data; sample data and feedback', async () => {
  const signup = await call('POST', '/api/auth/signup', { company_name: 'Second Co', manager_name: 'Sam', phone: '+44 7700 900123', password: 'another-pass' }, { auth: '' });
  assert.equal(signup.body.company.phone, '+447700900123');
  const other = signup.headers.get('set-cookie').split(';')[0];

  assert.deepEqual((await call('GET', '/api/pgs', null, { auth: other })).body, []);
  const mine = (await call('GET', '/api/pgs')).body;
  assert.ok(mine.length > 0);
  assert.equal((await call('GET', `/api/pgs/${mine[0].id}`, null, { auth: other })).status, 404);

  const cfg = (await call('GET', '/api/config', null, { auth: other })).body;
  assert.equal(cfg.company.company_name, 'Second Co');
  assert.equal(cfg.empty, true);
  assert.equal((await call('POST', '/api/sample-data', null, { auth: other })).status, 201);
  const pgs = (await call('GET', '/api/pgs', null, { auth: other })).body;
  assert.deepEqual(pgs.map((p) => [p.name, p.bed_count]).sort(), [['Lotus Ladies Hostel', 8], ['Sunrise PG', 12]]);
  const dash = (await call('GET', '/api/dashboard', null, { auth: other })).body;
  assert.deepEqual([dash.beds.total, dash.beds.occupied, dash.beds.booked], [20, 7, 1]);
  assert.equal((await call('POST', '/api/sample-data', null, { auth: other })).status, 409, 'only into an empty account');

  assert.equal((await call('POST', '/api/feedback', { message: 'Love the bed board', page: '#/bedboard' }, { auth: other })).status, 201);
  assert.equal((await app.platform.listFeedback())[0].company_name, 'Second Co');
});

test('invite code is required when configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-invite-'));
  const invitedDb = await createTestDatabase();
  const invited = createApp({ dataDir: dir, inviteCode: 'BETA2026', databaseUrl: invitedDb.url });
  await invited.ready;
  const srv = http.createServer(invited);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/signup`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) });
  const input = { company_name: 'Invited Co', manager_name: 'Ivy', phone: '9123456789', password: 'password123' };
  try {
    const denied = await post(input);
    assert.equal(denied.status, 400);
    assert.ok((await denied.json()).details.invite_code);
    assert.equal((await post({ ...input, invite_code: 'BETA2026' })).status, 201);
  } finally {
    srv.close();
    await invited.close();
    await invitedDb.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
