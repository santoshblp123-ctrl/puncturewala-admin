// PunctureWala 24x7 Service Worker with Push Notifications
const CACHE_NAME = 'puncturewala-v5';
const ASSETS_TO_CACHE = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Let API requests bypass cache
  if (event.request.url.includes('/api/')) {
    return;
  }
  // For HTML navigation requests, network first so code changes reflect immediately
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Push Notification Event ──────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {
    title: '🔔 PunctureWala 24x7',
    body: 'नया अपडेट उपलब्ध है।',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'pw-alert-' + Date.now(),
    data: { url: './' }
  };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    tag: data.tag || 'pw-alert',
    vibrate: [300, 100, 300, 100, 400],
    data: data.data || { url: './' },
    renotify: true,
    requireInteraction: true,
    actions: [
      { action: 'open', title: '📲 ऐप खोलें' },
      { action: 'close', title: 'हटाएं' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Notification Click Event ─────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) ? event.notification.data.url : './';

  if (event.action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
