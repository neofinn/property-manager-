'use strict';

// Makes the app installable and lets the shell open quickly on a phone.
// API requests are never cached: data always comes fresh from the server.

const CACHE = 'pm-shell-v1';
const SHELL = ['/styles.css', '/app.js', '/auth.js', '/favicon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () => new Response('<h1>You are offline</h1><p>Connect to the internet and reload.</p>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    return;
  }

  // Static files: always try the network first so a new release shows up
  // straight away; fall back to the cached copy when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
