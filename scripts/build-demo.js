'use strict';

// Builds dist/property-manager-demo.html: the whole app (pages, API and a
// SQLite engine) in one self-contained page, for publishing as a claude.ai
// artifact. Requires the sql.js dev dependency (npm install).
// Usage: npm run build:demo

const fs = require('node:fs');
const path = require('node:path');
const { bundle } = require('./bundle');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Inline scripts must not contain a literal closing script tag.
const safeScript = (js) => js.replace(/<\/script/gi, '<\\/script');

function between(html, start, end) {
  const a = html.indexOf(start);
  const b = html.lastIndexOf(end);
  if (a < 0 || b < 0) throw new Error(`Markers not found: ${start} … ${end}`);
  return html.slice(a + start.length, b);
}

const sqlDir = path.join(path.dirname(require.resolve('sql.js')), '..', 'dist');
const sqlJs = fs.readFileSync(path.join(sqlDir, 'sql-wasm.js'), 'utf8');
const wasm = fs.readFileSync(path.join(sqlDir, 'sql-wasm.wasm')).toString('base64');

const appBody = between(read('public/index.html'), '<body>', '<script src="/app.js"></script>');
const authMain = between(read('public/auth.html'), '<body class="auth-page">', '<script src="/auth.js"></script>');

const html = `<title>PG Manager</title>
<style>
${read('public/styles.css')}
/* Demo page */
.demo-splash { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding-inline: 16px; color: var(--muted); }
.demo-banner { margin: 0; padding: 8px 16px; background: var(--warn-bg); color: var(--warn); font-size: 13px; text-align: center; }
.save-status { font-size: 12px; color: var(--muted); white-space: nowrap; }
.save-status[data-tone="ok"] { color: var(--good); }
.save-status[data-tone="bad"] { color: var(--bad); }
@media (max-width: 480px) { .save-status:not([data-tone="bad"]) { display: none; } }
html, body { background: var(--bg); }
</style>

<div class="demo-splash" id="demo-splash">Starting PG Manager…</div>
<p class="demo-banner" id="demo-banner" hidden>Preview mode: changes are not saved. Open this page in claude.ai while signed in to keep your data.</p>

<div class="auth-page" id="auth-screen" hidden>
${authMain.replace(
  "<span class=\"hint\">You'll log in with this number.",
  "<span class=\"hint\">Your company name, manager name and phone number are shared with the app owner for this beta. You'll log in with this number.",
)}
</div>

<div id="app-screen" hidden>
${appBody.replace('<span class="account-name" id="account-name"></span>', '<span class="save-status" id="save-status" role="status"></span>\n      <span class="account-name" id="account-name"></span>')}
</div>

<script>window.PM_DEMO = true;</script>
<script>${safeScript(sqlJs)}</script>
<script>window.PM_SQL_WASM = "${wasm}";</script>
<script>${safeScript(read('public/app.js'))}</script>
<script>${safeScript(read('public/auth.js'))}</script>
<script>${safeScript(bundle('src/browser/demo-shell.js'))};</script>
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'property-manager-demo.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);
