// sw.js - ARC Team Topo Finder Service Worker
// Field-ready: load once at home, use offline in remote NZ (e.g. rescue missions).
// Ensures the app shell loads from cache on cold start when offline (e.g. Android).

const CACHE_NAME = 'arc-topo-finder-v5.9';

// Critical assets: must be cached for offline. App shell first so install succeeds even if CDN fails.
const CRITICAL_ASSETS = [
    '/',
    '/Index.html',
    '/app.js',
    '/manifest.json',
    '/Acrlogo.png',
    '/Topo.html',
    '/Topo2.html'
];
const OPTIONAL_ASSETS = [
    'https://cdn.tailwindcss.com'
];

const OFFLINE_DOCS = ['/Index.html', '/'];  // Try these in order for any document request.

function isAppOrigin(url) {
    try {
        return new URL(url).origin === self.location.origin;
    } catch (e) {
        return false;
    }
}

/** For a navigation to our app, return the first cached document we have (so we never hit network when offline). */
function getCachedAppDoc(cache) {
    return OFFLINE_DOCS.reduce((p, path) => p.then((r) => r || cache.match(path)), Promise.resolve(null));
}

// 1. Install: cache critical assets first; optional (e.g. Tailwind) must not block activation
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Caching critical offline assets');
                return cache.addAll(CRITICAL_ASSETS);
            })
            .then(() => {
                return caches.open(CACHE_NAME).then((cache) =>
                    Promise.allSettled(OPTIONAL_ASSETS.map((url) => cache.add(url)))
                );
            })
            .then(() => self.skipWaiting())
    );
});

// 2. Activate: take control immediately so we can serve on next navigation
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    event.waitUntil(self.clients.claim());
});

// 3. Fetch: for document navigations to our origin, prefer cache so cold start works offline
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = request.url;
    const isNav = request.mode === 'navigate';

    if (url.includes('api.open-meteo.com') || url.includes('api.counterapi.dev')) {
        return;
    }

    event.respondWith(
        (function respond() {
            // Navigation to our app: try cache first (by request URL, then by known app doc URLs)
            // so we never need the network when offline and avoid Android "splash only" issue.
            if (isNav && isAppOrigin(url)) {
                return caches.open(CACHE_NAME).then((cache) => {
                    return cache.match(request)
                        .then((cached) => cached || getCachedAppDoc(cache))
                        .then((cached) => {
                            if (cached) return cached;
                            return fetch(request)
                                .then((res) => {
                                    if (res && res.ok) {
                                        const clone = res.clone();
                                        cache.put(request, clone);
                                    }
                                    return res;
                                })
                                .catch(() => getCachedAppDoc(cache).then((f) => f || new Response(
                                    '<!DOCTYPE html><html><body><p>Offline. Open the app once with data to cache it.</p></body></html>',
                                    { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html' } }
                                )));
                        });
                });
            }
            // All other requests: cache-first, then network
            return caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request)
                    .then((res) => {
                        if (res && res.ok && isAppOrigin(url)) {
                            const clone = res.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                        }
                        return res;
                    })
                    .catch(() => {
                        if (!isNav) return undefined;
                        return caches.open(CACHE_NAME).then((cache) => getCachedAppDoc(cache));
                    });
            });
        })()
    );
});