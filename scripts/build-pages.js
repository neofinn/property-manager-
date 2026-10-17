'use strict';

// Builds dist-pages/: the app's pages as static files for GitHub Pages (or any
// static host), talking to the API on a Supabase Edge Function.
// Usage: PM_API_BASE=https://<ref>.supabase.co/functions/v1/api npm run build:pages

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const out = path.join(root, 'dist-pages');
const apiBase = process.env.PM_API_BASE || 'https://xlrnrlhrbuobzqxkinkc.supabase.co/functions/v1/api';

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Absolute links become relative so the site works under /<repo>/.
function rewriteHtml(html) {
  return html
    .replaceAll('href="/login"', 'href="./login.html"')
    .replaceAll('href="/signup"', 'href="./signup.html"')
    .replaceAll('href="/"', 'href="./index.html"')
    .replaceAll('href="/', 'href="./')
    .replaceAll('src="/', 'src="./')
    .replace('<script src="./', '<script src="./config.js"></script>\n  <script src="./api-client.js"></script>\n  <script src="./');
}

const pages = { 'index.html': 'index.html', 'login.html': 'auth.html', 'signup.html': 'auth.html', 'admin.html': 'admin.html' };
for (const [target, source] of Object.entries(pages)) {
  fs.writeFileSync(path.join(out, target), rewriteHtml(fs.readFileSync(path.join(pub, source), 'utf8')));
}

for (const file of ['app.js', 'auth.js', 'admin.js', 'api-client.js', 'styles.css', 'favicon.svg', 'icon-192.png', 'icon-512.png']) {
  fs.copyFileSync(path.join(pub, file), path.join(out, file));
}

const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = './index.html';
manifest.scope = './';
manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: `.${icon.src}` }));
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

fs.writeFileSync(path.join(out, 'config.js'), `window.PM_API_BASE = ${JSON.stringify(apiBase)};\n`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Wrote dist-pages/ (API: ${apiBase})`);
