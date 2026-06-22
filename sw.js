const CACHE = 'quixilver-v1';
const ASSETS = [
  '/quixcalendar/',
  '/quixcalendar/index.html',
  '/quixcalendar/icon.svg',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Outfit:wght@300..700&family=JetBrains+Mono:wght@400;700&display=swap'
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, fall back to cache for the app shell
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network-first for Firebase (Firestore, Auth) — never cache these
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    return; // let browser handle normally
  }

  // For the app shell — try network, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache a fresh copy
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
