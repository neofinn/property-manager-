'use strict';

// The claude.ai demo runs the API in the page on sql.js; check it behaves like the server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { createBackend } = require('../src/browser/backend');

test('in-page backend: sign-up, data, files, logout and a save/reload round trip', async () => {
  const SQL = await initSqlJs();
  let token = null;
  const feedback = [];
  const options = {
    SQL,
    getToken: () => token,
    setToken: (t) => (token = t),
    onFeedback: (company, body) => feedback.push([company.company_name, body.message]),
  };
  let backend = await createBackend(options);
  const call = (method, url, body) => backend.request(method, url, body && JSON.stringify(body));

  assert.equal((await call('GET', '/api/config')).status, 401);
  const signup = await call('POST', '/api/auth/signup', { company_name: 'Demo Co', manager_name: 'Asha', phone: '98450 12345', password: 'password1' });
  assert.equal(signup.status, 201);
  assert.equal((await call('POST', '/api/auth/signup', { company_name: 'X', manager_name: 'Y', phone: '9845012346', password: 'password1' })).status, 400);
  assert.equal((await call('POST', '/api/sample-data')).status, 201);
  assert.equal((await call('GET', '/api/dashboard')).json.counts.properties, 5);

  const doc = await call('POST', '/api/documents', { title: 'ID', file: { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF hi').toString('base64') } });
  const file = await call('GET', doc.json.file_url);
  assert.equal(Buffer.from(file.file.bytes).toString(), '%PDF hi');
  assert.equal((await call('POST', '/api/feedback', { message: 'nice' })).status, 201);
  assert.deepEqual(feedback, [['Demo Co', 'nice']]);

  // Concurrent requests are queued, not interleaved.
  const results = await Promise.all([1, 2, 3].map((i) => call('POST', '/api/contacts', { name: `Contact ${i}` })));
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);

  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/config')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { phone: '+919845012345', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { phone: '9845012345', password: 'password1' })).status, 200);

  backend = await createBackend({ ...options, bytes: backend.export() });
  assert.equal((await call('GET', '/api/properties')).json.length, 5);
  assert.equal((await call('DELETE', '/api/properties/1')).status, 409, 'foreign keys still enforced after reload');
});
