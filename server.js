'use strict';

const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  currency: process.env.CURRENCY || 'INR',
  user: process.env.APP_USER,
  password: process.env.APP_PASSWORD,
});

http.createServer(app).listen(port, host, () => {
  console.log(`Property Manager CRM running at http://${host}:${port}`);
  if (!process.env.APP_PASSWORD) {
    console.log('Tip: set APP_PASSWORD (and optionally APP_USER) to require a login.');
  }
});
