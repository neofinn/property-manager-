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
  databaseUrl: process.env.DATABASE_URL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
});

app.ready
  .then(() => {
    const server = http.createServer(app).listen(port, host, () => {
      console.log(`Property Manager CRM running at http://${host}:${port}`);
      console.log(`Database: ${app.platform.storage === 'postgres' ? 'Postgres (DATABASE_URL)' : 'SQLite files in DATA_DIR'}`);
      console.log(process.env.ADMIN_PASSWORD ? `Admin area: http://${host}:${port}/admin` : 'Tip: set ADMIN_PASSWORD to turn on the /admin area.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        server.close();
        await app.close();
        process.exit(0);
      });
    }
  })
  .catch((err) => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
