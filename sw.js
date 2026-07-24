/* Acolite — Service Worker : app hors-ligne (coque en cache, réseau d'abord pour le HTML) */
const CACHE = 'acolite-v49';
/* Cache séparé pour les tuiles de la carte : elles sont nombreuses et on les
   plafonne, alors que la coque de l'app doit rester intacte. */
const TILES = 'acolite-tiles-v1';
const TILE_MAX = 500;
const SHELL = [
  './index.html', './style.css', './app.js', './boot-check.js', './config.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
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
  /* Tuiles de la carte : cache d'abord. Une tuile ne change jamais, et c'est ce
     qui rend la carte consultable en avion ou à l'étranger sans données —
     tout le reste du voyage l'est déjà. On plafonne pour ne pas remplir le
     disque du visiteur : au-delà de TILE_MAX, les plus anciennes sautent. */
  else if(url.hostname === 'tile.openstreetmap.org'){
    e.respondWith(caches.open(TILES).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      /* une réponse opaque (sans CORS) a un status 0 : r.ok est faux alors que
         l'image est bonne. On l'accepte quand même, sinon rien n'est gardé. */
      if(r.ok || r.type === 'opaque'){
        c.put(e.request, r.clone());
        c.keys().then(ks => { if(ks.length > TILE_MAX) ks.slice(0, ks.length - TILE_MAX).forEach(k => c.delete(k)); });
      }
      return r;
    }))));
  }
  /* Autres APIs externes : réseau uniquement — les données de l'app vivent déjà dans localStorage */
});
