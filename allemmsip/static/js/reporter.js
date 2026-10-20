/* ============================================================
   uvacSIP — Reportero de monitoreo (Fase 2)
   ------------------------------------------------------------
   Manda eventos (conectado, llamadas, latido) al recolector del
   panel de admin. Es "fuego y olvido": si falla el envío, NO afecta
   en nada al softphone ni a las llamadas. NO toca el motor (sip.js).
   ============================================================ */
(function () {
    'use strict';

    var UvacReporter = {
        ext: null,
        token: '',                        // se llena desde Ajustes (settings.json)
        url: '',                          // URL absoluta del collector.php; vacío = apagado
        hbTimer: null,
        callStart: 0,
        callNum: '',
        callDir: '',

        // Arranca el reporte para una extensión (al registrarse)
        init: function (ext) {
            this.ext = String(ext || '');
            if (!this.ext) return;
            this.report('conectado');
            this._startHeartbeat();
        },

        _startHeartbeat: function () {
            var self = this;
            if (this.hbTimer) clearInterval(this.hbTimer);
            // Latido cada 20s para que el panel sepa que sigue en línea
            this.hbTimer = setInterval(function () { self.report('heartbeat'); }, 20000);
        },

        stopHeartbeat: function () {
            if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
        },

        // Inicio de llamada (dir: 'saliente' | 'entrante')
        callStarted: function (dir, number) {
            this.callStart = Date.now();
            this.callDir = dir || '';
            this.callNum = String(number || '');
            this.report('llamada_inicio', this.callNum, 0, this.callDir);
        },

        // Fin de llamada (calcula duración)
        callEnded: function () {
            var dur = this.callStart ? Math.round((Date.now() - this.callStart) / 1000) : 0;
            this.report('llamada_fin', this.callNum, dur, this.callDir);
            this.callStart = 0; this.callNum = ''; this.callDir = '';
        },

        // Envío fuego-y-olvido (nunca rompe nada). Registra el resultado en la
        // consola para ver fácil si el reporte llega al panel admin o falla.
        report: function (type, number, dur, dir) {
            if (!this.ext || !this.url) return;
            // 'desconectado' = me voy. Corta los latidos de inmediato para que un
            // latido rezagado NO revuelva la presencia y deje un "fantasma" EN
            // LÍNEA tras cerrar sesión / desregistrar. (Bug: antes el latido
            // seguía corriendo y revivía la extensión aunque ya no estuviera.)
            if (type === 'desconectado') this.stopHeartbeat();
            var self = this;
            try {
                fetch(this.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: this.token, ext: this.ext, type: type,
                        number: number || '', dur: dur || 0, dir: dir || ''
                    }),
                    keepalive: true
                })
                .then(function (r) { return r.text().then(function (t) { return { s: r.status, t: t }; }); })
                .then(function (x) {
                    try { console.log('%c[Monitor→admin] ' + type + ' ext ' + self.ext + ' → HTTP ' + x.s + ' ' + x.t,
                        'color:' + (x.s === 200 ? '#1c7c54' : '#dc2626') + ';font-weight:bold'); } catch (e) {}
                })
                .catch(function (e) {
                    try { console.log('%c[Monitor→admin] ' + type + ' FALLÓ (red/CSP): ' + (e && e.message),
                        'color:#dc2626;font-weight:bold'); } catch (e2) {}
                });
            } catch (e) { /* silencioso */ }
        }
    };

    window.UvacReporter = UvacReporter;

    // Avisar 'desconectado' AL INSTANTE cuando el agente cierra/recarga/oculta
    // la pestaña, para que desaparezca del panel de inmediato (presencia precisa).
    // Usa sendBeacon (el método confiable para enviar algo al cerrar la página).
    window.addEventListener('pagehide', function () {
        try {
            if (!UvacReporter.ext || !UvacReporter.url) return;
            var body = JSON.stringify({ token: UvacReporter.token, ext: UvacReporter.ext, type: 'desconectado' });
            if (navigator.sendBeacon) {
                navigator.sendBeacon(UvacReporter.url, new Blob([body], { type: 'application/json' }));
            } else {
                UvacReporter.report('desconectado');
            }
        } catch (e) { /* silencioso */ }
    });
})();
