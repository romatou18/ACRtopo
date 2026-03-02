// sw.js - ARC Team Topo Finder Service Worker
// - Offline: app works from cache when no connection.
// - Online: refresh fetches latest version (network-first), then cache is updated for next offline.

const CACHE_NAME = 'arc-topo-finder-v0.9';

const CRITICAL_ASSETS = [
    '/',
    '/Index.html',
    '/app.js',
    '/manifest.json',
    '/Acrlogo.png',
];
const OPTIONAL_ASSETS = [
    'https://cdn.tailwindcss.com'
];

const OFFLINE_DOCS = ['/Index.html', '/'];

function isAppOrigin(url) {
    try {
        return new URL(url).origin === self.location.origin;
    } catch (e) {
        return false;
    }
}

function getCachedAppDoc(cache) {
    return OFFLINE_DOCS.reduce((p, path) => p.then((r) => r || cache.match(path)), Promise.resolve(null));
}

// 1. Install: prime cache for offline; optional assets must not block activation
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CRITICAL_ASSETS))
            .then(() => caches.open(CACHE_NAME).then((cache) =>
                Promise.allSettled(OPTIONAL_ASSETS.map((url) => cache.add(url)))
            ))
            .then(() => self.skipWaiting())
    );
});

// 2. Activate: take control and prune old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) =>
            Promise.all(
                cacheNames.map((name) => (name !== CACHE_NAME ? caches.delete(name) : undefined))
            )
        )
    );
    event.waitUntil(self.clients.claim());
});

// 3. Fetch: network-first for app shell when online, cache fallback when offline
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = request.url;
    const isNav = request.mode === 'navigate';

    if (url.includes('api.open-meteo.com') || url.includes('api.counterapi.dev')) {
        return;
    }

    event.respondWith(
        (function respond() {
            // App shell (navigation or same-origin app assets): network-first so refresh gets latest
            if ((isNav || isAppOrigin(url)) && !url.includes('api.')) {
                return fetch(request)
                    .then((res) => {
                        if (res && res.ok && (isNav || isAppOrigin(url))) {
                            const clone = res.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                        }
                        return res;
                    })
                    .catch(() => {
                        return caches.open(CACHE_NAME).then((cache) => {
                            if (isNav) return getCachedAppDoc(cache).then((f) => f || new Response(
                                '<!DOCTYPE html><html><body><p>Offline. Open the app once with data to cache it.</p></body></html>',
                                { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html' } }
                            ));
                            return cache.match(request);
                        });
                    });
            }
            // Other (e.g. CDN): network first, then cache
            return fetch(request)
                .then((res) => {
                    if (res && res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(request));
        })()
    );
});
