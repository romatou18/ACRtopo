// sw.js - ARC Team Topo Finder Service Worker
// - Offline: app works from cache when no connection.
// - Online: refresh fetches latest version (network-first), then cache is updated for next offline.

const CACHE_NAME = 'arc-topo-finder-v1.0';

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

// 3. Fetch: Network-First with Cache Fallback
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip tracking/API calls to ensure altitude/hits work normally
    if (url.hostname.includes('api.')) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                // If network is good, update the cache and return response
                if (response && response.status === 200) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => {
                // NETWORK FAIL: Use Cache
                return caches.match(request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;
                    
                    // If it's a page navigation and nothing is cached, show offline page
                    if (request.mode === 'navigate') {
                        return caches.match('/Index.html');
                    }
                });
            })
    );
});
