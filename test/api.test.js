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
  assert.match(res.body, /Property Manager/);
  assert.equal((await call('GET', '/../package.json')).status, 404);
});

test('validates required fields and types', async () => {
  const res = await call('POST', '/api/properties', { type: 'Castle', monthly_rent: 'abc' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.name);
  assert.ok(res.body.details.address);
  assert.ok(res.body.details.type);
  assert.ok(res.body.details.monthly_rent);
});

test('full CRM flow: property, tenant, agreement, payments and reminders', async () => {
  const property = (await call('POST', '/api/properties', { name: 'Sea Breeze 1A', address: '1 Beach Rd', monthly_rent: 20000 })).body;
  assert.equal(property.status, 'Vacant', 'default applied');

  const tenant = (await call('POST', '/api/tenants', { full_name: 'Asha Rao', phone: '+91 90000 12345', email: 'asha@example.com', property_id: property.id })).body;
  assert.equal(tenant.property_id_label, 'Sea Breeze 1A');

  const bad = await call('POST', '/api/agreements', {
    property_id: property.id, tenant_id: tenant.id, start_date: '2026-05-01', end_date: '2026-04-01', monthly_rent: 20000, rent_due_day: 5,
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.end_date);

  const agreement = (await call('POST', '/api/agreements', {
    property_id: property.id, tenant_id: tenant.id, start_date: '2026-07-15', end_date: '2026-11-30', monthly_rent: 20000, rent_due_day: 5,
  })).body;
  assert.equal(agreement._label, 'Asha Rao @ Sea Breeze 1A');

  // July paid fully, August partially, September and October not at all.
  await call('POST', '/api/rent_payments', { agreement_id: agreement.id, period: '2026-07', amount: 20000, paid_on: '2026-07-15' });
  await call('POST', '/api/rent_payments', { agreement_id: agreement.id, period: '2026-08', amount: 5000, paid_on: '2026-08-05' });

  const rem = (await call('GET', '/api/reminders?today=2026-10-03&days=7')).body;
  const rent = rem.rent.filter((r) => r.agreement_id === agreement.id);
  assert.deepEqual(rent.map((r) => [r.period, r.state, r.outstanding]), [
    ['2026-08', 'overdue', 15000],
    ['2026-09', 'overdue', 20000],
    ['2026-10', 'upcoming', 20000],
  ]);
  assert.match(rent[0].message, /Asha Rao/);
  assert.match(rent[0].links.whatsapp, /^https:\/\/wa\.me\/919000012345\?text=/);
  assert.match(rent[0].links.email, /^mailto:asha@example\.com/);

  // Agreement ends within 60 days -> renewal reminder.
  assert.ok(rem.agreements.some((a) => a.agreement_id === agreement.id && a.state === 'expiring'));

  // Logging a reminder shows up as last_reminded.
  assert.equal((await call('POST', '/api/reminders/log', { key: rent[0].key, channel: 'whatsapp' })).status, 201);
  const rem2 = (await call('GET', '/api/reminders?today=2026-10-03&days=7')).body;
  assert.equal(rem2.rent.find((r) => r.key === rent[0].key).last_reminded.channel, 'whatsapp');

  const dash = (await call('GET', '/api/dashboard?today=2026-10-03')).body;
  assert.equal(dash.rent.expected_this_month, 20000);
  assert.ok(dash.rent.overdue_total >= 35000);

  // Property with an agreement cannot be deleted (RESTRICT).
  assert.equal((await call('DELETE', `/api/properties/${property.id}`)).status, 409);
  // Deleting the agreement cascades to its payments.
  assert.equal((await call('DELETE', `/api/agreements/${agreement.id}`)).status, 200);
  const payments = (await call('GET', `/api/rent_payments?agreement_id=${agreement.id}`)).body;
  assert.equal(payments.length, 0);
});

test('bills, schedules and search/filter', async () => {
  const property = (await call('POST', '/api/properties', { name: 'Hill Top', address: 'Hill Rd' })).body;
  const bill = (await call('POST', '/api/bills', { property_id: property.id, category: 'Water', amount: 450.456, due_date: '2026-10-01' })).body;
  assert.equal(bill.amount, 450.46);
  assert.equal(bill.status, 'Unpaid');

  let rem = (await call('GET', '/api/reminders?today=2026-10-03')).body;
  assert.equal(rem.bills.find((b) => b.bill_id === bill.id).state, 'overdue');

  const updated = (await call('PATCH', `/api/bills/${bill.id}`, { status: 'Paid', paid_on: '2026-10-03' })).body;
  assert.equal(updated.status, 'Paid');
  assert.equal(updated.category, 'Water', 'partial update keeps other fields');
  rem = (await call('GET', '/api/reminders?today=2026-10-03')).body;
  assert.ok(!rem.bills.some((b) => b.bill_id === bill.id));

  await call('POST', '/api/schedules', { title: 'Inspection', starts_at: '2026-10-04T09:30', property_id: property.id });
  rem = (await call('GET', '/api/reminders?today=2026-10-03&days=1')).body;
  assert.ok(rem.schedules.some((s) => s.title === 'Inspection' && s.property_name === 'Hill Top'));

  const found = (await call('GET', '/api/bills?q=Hill')).body;
  assert.ok(found.some((b) => b.id === bill.id), 'search matches referenced property name');
  const filtered = (await call('GET', '/api/bills?status=Unpaid')).body;
  assert.ok(!filtered.some((b) => b.id === bill.id));
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
  assert.equal((await call('GET', '/api/properties/abc')).status, 404);
  assert.equal((await call('GET', '/api/properties/99999')).status, 404);
  assert.equal((await call('GET', '/api/properties?sort=name;DROP TABLE x')).status, 200);
});

test('due date rules', () => {
  const a = { start_date: '2026-01-20', end_date: '2026-12-10', rent_due_day: 5 };
  assert.equal(dueDateFor(a, '2026-01'), '2026-01-20', 'first month due on move-in');
  assert.equal(dueDateFor(a, '2026-02'), '2026-02-05');
  assert.equal(dueDateFor(a, '2026-12'), '2026-12-05');
  assert.equal(dueDateFor({ ...a, rent_due_day: 15 }, '2026-12'), null, 'not due after agreement ends');
});

test('signup validation, login, logout and sessions', async () => {
  const bad = await call('POST', '/api/auth/signup', { company_name: '', manager_name: 'A', phone: '123', password: 'short' }, { auth: '' });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.details).sort(), ['company_name', 'manager_name', 'password', 'phone']);

  const dup = await call('POST', '/api/auth/signup', { company_name: 'X Co', manager_name: 'Xavier', phone: '+91 98765 43210', password: 'password123' }, { auth: '' });
  assert.match(dup.body.details.phone, /already exists/);

  // Not logged in: API is 401, pages redirect to the login page.
  assert.equal((await call('GET', '/api/properties', null, { auth: '' })).status, 401);
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
  const csrf = await fetch(`${base}/api/properties`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);
});

test('each company only sees its own data; sample data and feedback', async () => {
  const signup = await call('POST', '/api/auth/signup', { company_name: 'Second Co', manager_name: 'Sam', phone: '+44 7700 900123', password: 'another-pass' }, { auth: '' });
  assert.equal(signup.body.company.phone, '+447700900123');
  const other = signup.headers.get('set-cookie').split(';')[0];

  assert.deepEqual((await call('GET', '/api/properties', null, { auth: other })).body, []);
  const mine = (await call('GET', '/api/properties')).body;
  assert.ok(mine.length > 0);
  assert.equal((await call('GET', `/api/properties/${mine[0].id}`, null, { auth: other })).status, 404);

  const cfg = (await call('GET', '/api/config', null, { auth: other })).body;
  assert.equal(cfg.company.company_name, 'Second Co');
  assert.equal(cfg.empty, true);
  assert.equal((await call('POST', '/api/sample-data', null, { auth: other })).status, 201);
  const props = (await call('GET', '/api/properties', null, { auth: other })).body;
  assert.ok(props.some((p) => p.type === 'PG / Hostel'));
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

test('PG / hostel has total beds and bed price; other types have rent, area and status', async () => {
  const hostel = (await call('POST', '/api/properties', { name: 'Bed Count Hostel', type: 'PG / Hostel', address: 'H Rd', total_beds: 10, rent_per_bed: 6500, monthly_rent: 99, status: 'Occupied', units: 4 })).body;
  assert.deepEqual([hostel.total_beds, hostel.rent_per_bed], [10, 6500]);
  assert.deepEqual([hostel.monthly_rent, hostel.status, hostel.units], [null, null, null], 'whole-property fields are cleared for a PG');

  // New rooms take the hostel's bed price; tenants fill beds even before one is picked.
  const room = (await call('POST', '/api/rooms', { property_id: hostel.id, room_number: 'G1', total_beds: 2 })).body;
  assert.equal(room.rent_per_bed, 6500);
  await call('POST', '/api/tenants', { full_name: 'Asha', property_id: hostel.id });
  const before = (await call('GET', '/api/dashboard')).body.beds;
  let row = (await call('GET', `/api/properties/${hostel.id}`)).body;
  assert.deepEqual([row.bed_count, row.tenant_count], [2, 1]);

  // Switching to a shop clears the bed fields and keeps the shop ones.
  const shop = (await call('PATCH', `/api/properties/${hostel.id}`, { type: 'Shop', area_sqft: 300, furnishing: 'Bare shell', monthly_rent: 30000 })).body;
  assert.deepEqual([shop.total_beds, shop.rent_per_bed, shop.pg_for], [null, null, null]);
  assert.deepEqual([shop.area_sqft, shop.furnishing, shop.monthly_rent], [300, 'Bare shell', 30000]);
  const after = (await call('GET', '/api/dashboard')).body.beds;
  assert.equal(before.total - after.total, 8, 'the 10 planned beds became the 2 real ones');
  assert.equal(before.occupied - after.occupied, 1);

  // Bed prices fill an empty bed count; floor prices are for other types.
  const priced = await call('POST', '/api/properties', {
    name: 'Priced PG', type: 'PG / Hostel', address: 'P',
    bed_prices: [{ label: '2-sharing AC', beds: '4', price: '9000' }, { label: '', beds: '', price: '' }, { label: 'Ground floor', beds: 6, price: 7000.456 }],
  });
  assert.equal(priced.status, 201);
  assert.deepEqual(priced.body.bed_prices, [{ label: '2-sharing AC', beds: 4, price: 9000 }, { label: 'Ground floor', beds: 6, price: 7000.46 }]);
  assert.equal(priced.body.total_beds, 10);
  const bad = await call('POST', '/api/properties', { name: 'Bad', type: 'PG / Hostel', address: 'P', bed_prices: [{ label: 'No price' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.details.bed_prices, /needs a price/);
  const floors = (await call('PATCH', `/api/properties/${priced.body.id}`, { type: 'Office', floor_prices: [{ label: '1st floor', area: 2000, price: 80000 }] })).body;
  assert.deepEqual([floors.bed_prices, floors.floor_prices], [null, [{ label: '1st floor', area: 2000, price: 80000 }]]);
  const csv = (await call('GET', '/api/properties/export.csv?q=Priced')).body;
  assert.match(csv, /1st floor \(2000 sq ft\): 80000/);

  for (const type of ['Villa', 'Apartment', 'SOHO', 'Office Cabin', 'Shop']) {
    assert.equal((await call('POST', '/api/properties', { name: type, type, address: 'A' })).status, 201);
  }
  assert.equal((await call('POST', '/api/properties', { name: 'Bad', type: 'Castle', address: 'A' })).status, 400);
});

test('PG rooms and beds: auto beds, linking, occupancy and rent', async () => {
  const pg = (await call('POST', '/api/properties', { name: 'Test PG', type: 'PG / Hostel', address: 'PG Rd', pg_for: 'Ladies', meals: 'All 3 meals', gate_timings: 'Gate closes 10 pm' })).body;
  const other = (await call('POST', '/api/properties', { name: 'Other', type: 'Independent House', address: 'X' })).body;
  const room = (await call('POST', '/api/rooms', { property_id: pg.id, room_number: '101', sharing: 'Triple', total_beds: 3, rent_per_bed: 8000 })).body;
  assert.equal(room._label, 'Room 101 · Test PG');
  assert.equal(room.bed_count, 3, 'beds created automatically');

  let beds = (await call('GET', `/api/beds?room_id=${room.id}&sort=bed_label&dir=asc`)).body;
  assert.deepEqual(beds.map((b) => [b.bed_label, b.monthly_rent, b.occupant]), [['Bed 1', 8000, null], ['Bed 2', 8000, null], ['Bed 3', 8000, null]]);

  // Raising the bed count adds beds; it never removes them.
  await call('PATCH', `/api/rooms/${room.id}`, { total_beds: 4 });
  assert.equal((await call('GET', `/api/rooms/${room.id}`)).body.bed_count, 4);

  // Picking a bed fills in the room and property.
  const t1 = (await call('POST', '/api/tenants', { full_name: 'Priya', bed_id: beds[0].id })).body;
  assert.equal(t1.room_id, room.id);
  assert.equal(t1.property_id, pg.id);
  assert.equal(t1.bed_id_label, 'Bed 1 · Room 101 · Test PG');

  // A bed can't be given to two active tenants, or to a room/property it isn't in.
  const dup = await call('POST', '/api/tenants', { full_name: 'Meera', bed_id: beds[0].id });
  assert.equal(dup.status, 400);
  assert.match(dup.body.details.bed_id, /already occupied by Priya/);
  const wrong = await call('POST', '/api/tenants', { full_name: 'Meera', property_id: other.id, room_id: room.id });
  assert.match(wrong.body.details.room_id, /not in the selected property/);
  assert.equal((await call('POST', '/api/tenants', { full_name: 'Former', bed_id: beds[0].id, status: 'Former' })).status, 201);

  // Agreement rent defaults to the bed rent; overlapping agreements on a bed are rejected.
  const t2 = (await call('POST', '/api/tenants', { full_name: 'Meera' })).body;
  const agr = await call('POST', '/api/agreements', { tenant_id: t2.id, bed_id: beds[1].id, start_date: '2026-10-01', end_date: '2027-09-30', rent_due_day: 5 });
  assert.equal(agr.status, 201);
  assert.equal(agr.body.monthly_rent, 8000);
  assert.equal(agr.body.property_id, pg.id);
  const t2After = (await call('GET', `/api/tenants/${t2.id}`)).body;
  assert.equal(t2After.bed_id, beds[1].id, 'tenant moved onto the agreement bed');
  const overlap = await call('POST', '/api/agreements', { tenant_id: t1.id, bed_id: beds[1].id, start_date: '2027-01-01', end_date: '2027-12-31', monthly_rent: 8000, rent_due_day: 5 });
  assert.equal(overlap.status, 400);
  assert.match(overlap.body.details.bed_id, /active agreement with Meera/);

  const rem = (await call('GET', '/api/reminders?today=2026-10-06&days=0')).body;
  const r = rem.rent.find((x) => x.agreement_id === agr.body.id);
  assert.equal(r.property_name, 'Test PG, Room 101, Bed 2');
  assert.match(r.message, /Test PG, Room 101, Bed 2/);

  beds = (await call('GET', `/api/beds?room_id=${room.id}`)).body;
  assert.equal(beds.filter((b) => b.occupant).length, 2);
  const prop = (await call('GET', `/api/properties/${pg.id}`)).body;
  assert.deepEqual([prop.room_count, prop.bed_count, prop.occupied_beds], [1, 4, 2]);
  const dash = (await call('GET', '/api/dashboard')).body;
  assert.ok(dash.beds.total >= 4 && dash.beds.occupied >= 2);

  const opts = (await call('GET', '/api/beds/options')).body;
  assert.equal(opts.find((o) => o.id === beds.find((b) => b.occupant === 'Priya').id).parent, room.id);

  // A room whose bed has an agreement can't be deleted.
  assert.equal((await call('DELETE', `/api/rooms/${room.id}`)).status, 409);
});
