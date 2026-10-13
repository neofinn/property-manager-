'use strict';

const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  currency: process.env.CURRENCY || 'INR',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
  inviteCode: process.env.BETA_INVITE_CODE || '',
  trustProxy: process.env.TRUST_PROXY === '1',
});

const server = http.createServer(app).listen(port, host, () => {
  console.log(`Property Manager CRM running at http://${host}:${port}`);
  if (!process.env.BETA_INVITE_CODE) {
    console.log('Tip: set BETA_INVITE_CODE so only people you invite can sign up.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    app.close();
    process.exit(0);
  });
}
