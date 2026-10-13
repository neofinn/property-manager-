'use strict';

// Creates a demo company account filled with sample data.
// Usage: npm run seed   (respects DATA_DIR)
// Log in with phone 9999999999 and password demo12345.

const path = require('node:path');
const { createApp } = require('../src/app');

const app = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') });
const phone = process.env.DEMO_PHONE || '9999999999';
const password = process.env.DEMO_PASSWORD || 'demo12345';

try {
  const result = app.createDemoAccount({ phone, password, company_name: 'Demo Properties', manager_name: 'Demo Manager' });
  console.log(result.created ? 'Demo account created with sample data.' : 'Demo account already exists.');
  console.log(`Log in with phone ${phone} and password ${password}`);
} finally {
  app.close();
}
