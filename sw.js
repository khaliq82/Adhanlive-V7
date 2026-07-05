/**
 * AdhanLive Service Worker
 * Caches the app shell for fast loads.
 * Live data (mosque chunks, prayer times) always fetches fresh from network.
 */

const CACHE_NAME = 'adhanlive-v1';

// App shell — cache these for instant load
const SHELL_ASSETS = [
  '/',
  '/livemap',
  '/favicon.svg',
  '/earth.jpg',
  '/preview.jpg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
];

// Never cache these — always fetch fresh from network
const NETWORK_ONLY = [
  '/prayers-today.bin',
  '/prayers-today.json',
  '/mosques_mobile_',
  '/api/',
];

function isNetworkOnly(url) {
  return NETWORK_ONLY.some(pattern => url.includes(pattern));
}

// Install — cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('SW: Some shell assets failed to cache', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — network first for live data, cache first for shell
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always go to network for live data
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache first, fall back to network for shell assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for shell assets
        if (
          response.ok &&
          event.request.method === 'GET' &&
          !isNetworkOnly(url)
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached home page
        return caches.match('/');
      });
    })
  );
});
