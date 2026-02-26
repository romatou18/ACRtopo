// sw.js - ARC Topo Finder Service Worker
// Field-ready: load once at home, use offline in remote NZ (e.g. rescue missions).

const CACHE_NAME = 'arc-topo-finder-v5.7';

// Core files needed for full offline use after one load at home
const ASSETS_TO_CACHE = [
    '/',
    '/Index.html',
    '/Topo2.html',
    '/Acrlogo.png',
    '/manifest.json',
    'https://cdn.tailwindcss.com' // Cache Tailwind so styling works offline
];

const OFFLINE_FALLBACK = '/Index.html';

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
    const isNav = event.request.mode === 'navigate';

    // Don't intercept external APIs – let app handle "Offline" in try/catch
    if (url.includes('api.open-meteo.com') || url.includes('api.counterapi.dev')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                if (cachedResponse) return cachedResponse;
                return fetch(event.request)
                    .then((networkResponse) => {
                        if (networkResponse && networkResponse.ok && event.request.url.startsWith(self.location.origin)) {
                            const clone = networkResponse.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                        }
                        return networkResponse;
                    })
                    .catch((err) => {
                        if (isNav) {
                            return caches.match(OFFLINE_FALLBACK).then((fallback) => fallback || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
                        }
                        return undefined;
                    });
            })
    );
});