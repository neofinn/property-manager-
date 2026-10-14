'use strict';

// Prints beta sign-ups and feedback (the /admin page shows the same, with charts).
// Usage: npm run feedback   (respects DATA_DIR and DATABASE_URL)

const path = require('node:path');
const { Platform } = require('../src/platform');

(async () => {
  const platform = await new Platform({
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
    databaseUrl: process.env.DATABASE_URL || '',
  }).init();
  try {
    const companies = await platform.listCompanies();
    console.log(`\n${companies.length} account(s):`);
    console.table(companies.map(({ company_name, manager_name, phone, status, created_at, last_active_at }) => ({ company_name, manager_name, phone, status, created_at, last_active_at })));

    const feedback = await platform.listFeedback();
    console.log(`\n${feedback.length} feedback message(s):`);
    for (const f of feedback) {
      console.log(`\n[${f.created_at} UTC]${f.resolved ? ' (resolved)' : ''} ${f.company_name || 'deleted account'} – ${f.manager_name || ''} (${f.phone || ''}) on ${f.page || '?'}`);
      console.log(`  ${f.message.replace(/\n/g, '\n  ')}`);
    }
  } finally {
    await platform.close();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
