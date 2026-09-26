// Offline notice only (card #409). Nothing else.
//
// History: a caching service worker broke page loads on iOS (respondWith got
// null on a cache miss) and a later kill-switch caused a reload loop, so for a
// while no worker was registered at all. The price: when the phone could not
// reach this machine (Tailscale stuck), the installed app showed only its
// launch icon and never said why (owner, TG 6572, 2026-09-26).
//
// This worker is deliberately tiny, and each rule below is one of those
// lessons:
//  - It caches ONE file, /offline.html. App code (app.js, css, lang) is never
//    cached, so a stale app can never be served.
//  - It only answers top-level page loads of the app shell ('/' or
//    '/index.html'). /api/*, downloads, scripts and images go straight to the
//    network untouched (no respondWith at all).
//  - A network error or no answer within NAV_TIMEOUT_MS shows the offline
//    page. Any HTTP answer, even an error status, is passed through as is.
//  - respondWith never gets null: a cache miss falls back to Response.error(),
//    which is exactly what the browser would show without a worker.
//  - It never reloads a page, never claims open pages, never navigates.
//
// To switch it off again: restore the unregister-everything snippet in
// index.html and the self-unregistering stub here (git history, dc7f2962).

const OFFLINE_CACHE = 'marveen-offline-v1';
const OFFLINE_URL = '/offline.html';
const NAV_TIMEOUT_MS = 15000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .catch(() => {
        /* no offline page cached: navigations then fail exactly as without a worker */
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Purge every cache an older worker left behind (the old app-shell caches).
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .catch(() => {})
  );
});

function isAppShellNavigation(request) {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  return url.pathname === '/' || url.pathname === '/index.html';
}

// A navigate-mode Request cannot be re-created with an AbortSignal in every
// browser, so the timeout races the fetch instead of aborting it.
function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function offlineResponse() {
  try {
    const cached = await caches.match(OFFLINE_URL);
    if (cached) return cached;
  } catch {
    /* fall through */
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  if (!isAppShellNavigation(event.request)) return;
  event.respondWith(fetchWithTimeout(event.request).catch(() => offlineResponse()));
});
