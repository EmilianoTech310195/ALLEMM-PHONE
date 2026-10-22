/* ALLEMM SIP Web - service worker (generado por web/build.py) */
'use strict';
const VERSION = '__VERSION__';
const CACHE = 'allemmsip-' + VERSION;
const FILES = __FILES__;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
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
    if (url.origin !== self.location.origin) return;     // WSS, STUN, panel: directo a la red

    // La página: primero la red (para tomar versiones nuevas), si no hay, la copia.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true }))
        );
        return;
    }
    // Archivos de la app: copia local (versionada) y si falta, red.
    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
    );
});
