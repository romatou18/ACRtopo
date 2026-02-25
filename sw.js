// sw.js - ARC Topo Finder Service Worker

const CACHE_NAME = 'arc-topo-finder-v5.6';

// Add the core files your app needs to function offline
const ASSETS_TO_CACHE = [
    '/',
    '/Index.html',
    '/Topo2.html',
    '/Acrlogo.png',
    '/manifest.json',
    'https://cdn.tailwindcss.com' // Cache Tailwind so the app doesn't lose its styling offline
];

// 1. Install Step: Cache the files
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Caching offline assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => self.skipWaiting())
    );
});

// 2. Activate Step: Clean up old versions of the cache
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
    return self.clients.claim();
});

// 3. Fetch Step: Intercept network requests
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Ignore external APIs. We want these to fail gracefully so the app's try/catch blocks 
    // can display "Offline" instead of the Service Worker throwing an error.
    if (url.includes('api.open-meteo.com') || url.includes('api.counterapi.dev')) {
        return; 
    }

    // Cache-First Strategy for everything else
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // Return the cached version if we have it
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                // Otherwise, try to fetch it from the network
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Optionally cache new dynamic requests here, 
                        // but keeping it static is safer for this tool.
                        return networkResponse;
                    })
                    .catch((error) => {
                        console.error('[Service Worker] Fetch failed; returning offline fallback.', error);
                    });
            })
    );
});