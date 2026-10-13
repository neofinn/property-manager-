'use strict';

// Prints beta feedback and sign-ups.
// Usage: npm run feedback   (respects DATA_DIR)

const path = require('node:path');
const { Accounts } = require('../src/accounts');

const accounts = new Accounts(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
try {
  const companies = accounts.db.prepare('SELECT company_name, manager_name, phone, created_at, last_login_at FROM companies ORDER BY id').all();
  console.log(`\n${companies.length} beta account(s):`);
  console.table(companies);

  const feedback = accounts.listFeedback();
  console.log(`\n${feedback.length} feedback message(s):`);
  for (const f of feedback) {
    console.log(`\n[${f.created_at} UTC] ${f.company_name || 'deleted account'} – ${f.manager_name || ''} (${f.phone || ''}) on ${f.page || '?'}`);
    console.log(`  ${f.message.replace(/\n/g, '\n  ')}`);
  }
} finally {
  accounts.close();
}
