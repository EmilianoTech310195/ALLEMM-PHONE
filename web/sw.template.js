/* ALLEMM SIP Web - service worker (generado por web/build.py)
   Siempre pide al servidor la versión más reciente de cada archivo y solo
   usa la copia guardada si no hay red. Así nunca se mezclan archivos de
   versiones distintas cuando se actualiza la app en el servidor. */
'use strict';
const VERSION = '__VERSION__';
const CACHE = 'allemmsip-' + VERSION;
const FILES = __FILES__;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            // Uno por uno: si falta un archivo en el servidor, los demás igual se guardan
            // y el service worker nuevo se instala (antes se quedaba el viejo para siempre).
            .then((c) => Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith('allemmsip-') && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;     // WSS, STUN: directo a la red
    const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
    if (rel.startsWith('monitor/') || rel.startsWith('admin/')) return;   // recolector y panel: siempre red

    // Primero el servidor (sin caché HTTP); si no hay red, la copia guardada.
    // (Una navegación no admite opciones en fetch: se pide tal cual.)
    const network = req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' });
    event.respondWith(
        network
            .then((res) => {
                if (res && res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(req, { ignoreSearch: true })
                .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html', { ignoreSearch: true }) : undefined)))
    );
});
