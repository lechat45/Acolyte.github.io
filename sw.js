/* Acolite — Service Worker : app hors-ligne (coque en cache, réseau d'abord pour le HTML) */
const CACHE = 'acolite-v26';
const SHELL = [
  './index.html', './style.css', './app.js', './boot-check.js', './config.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(e.request.method !== 'GET') return;
  /* même origine : réseau d'abord (dernière version), cache en secours (mode avion) */
  if(url.origin === location.origin){
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(m => m || caches.match('./index.html')))
    );
  }
  /* APIs externes : réseau uniquement — les données de l'app vivent déjà dans localStorage */
});
