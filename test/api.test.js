'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const { dueDateFor } = require('../src/reminders');

let server;
let base;
let app;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  app = createApp({ dataDir });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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

  const file = await fetch(base + doc.file_url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), content);

  const html = (await call('POST', '/api/documents', {
    title: 'evil', file: { name: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') },
  })).body;
  const htmlRes = await fetch(base + html.file_url);
  assert.match(htmlRes.headers.get('content-disposition'), /^attachment/);

  let rem = (await call('GET', '/api/reminders')).body;
  assert.ok(rem.documents_unverified.some((d) => d.document_id === doc.id));
  await call('PATCH', `/api/documents/${doc.id}`, { verified: true, verified_on: '2026-10-01' });
  rem = (await call('GET', '/api/reminders')).body;
  assert.ok(!rem.documents_unverified.some((d) => d.document_id === doc.id));

  const before = fs.readdirSync(path.join(dataDir, 'uploads')).length;
  await call('DELETE', `/api/documents/${doc.id}`);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, before - 1);
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

test('basic auth when a password is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-auth-'));
  const secured = createApp({ dataDir: dir, password: 's3cret' });
  const srv = http.createServer(secured);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/api/config`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const ok = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from('admin:s3cret').toString('base64')}` } });
    assert.equal(ok.status, 200);
  } finally {
    srv.close();
    secured.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
