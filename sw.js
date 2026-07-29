/* Service worker.
 *
 * The app needs no network once installed — GPS is on-device — so the whole
 * shell is precached and the app works fully offline.
 *
 * Strategy is split, because pure cache-first got this wrong in a way that
 * matters: it served the previous version on every launch and only fetched the
 * update in the background, so a change was always one launch late with no
 * indication anything was stale.
 *
 *   - code (the document, JS, manifest): network-first with a short timeout,
 *     falling back to cache. Online you always get the current version; offline
 *     or on a dying marine signal you fall back to cache after NET_TIMEOUT_MS
 *     and carry on.
 *   - icons: cache-first. They're static and there's no reason to pay for them.
 *
 * Bump CACHE_VERSION whenever a shell file changes. */

const CACHE_VERSION = 'v6';
const CACHE_NAME = 'speedo-' + CACHE_VERSION;

const NET_TIMEOUT_MS = 2000;

const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await withTimeout(fetch(req), NET_TIMEOUT_MS);
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(() => {});
      return res;
    }
    throw new Error('bad response');
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // Offline, uncached, and it's a page load: hand back the shell rather than
    // the browser's offline dinosaur.
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (_) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isCode = req.mode === 'navigate' ||
                 /\.(?:html|js|webmanifest)$/.test(url.pathname);

  event.respondWith(isCode ? networkFirst(req) : cacheFirst(req));
});
