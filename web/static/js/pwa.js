/* ========================================
   ALLEMM SIP Web - Instalación como app (PWA)
   ========================================
   - Registra el service worker (la app abre aunque la red tarde).
   - iPhone/iPad: Safari no muestra botón de instalar; explicamos el
     "Compartir → Agregar a pantalla de inicio".
   - Android/Chrome y computadora: botón "Instalar app".
   ======================================== */
(function () {
    'use strict';

    var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var HIDE_KEY = 'allemm_install_hint_hidden';

    if ('serviceWorker' in navigator && window.isSecureContext) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('sw.js').catch(function (err) {
                if (window.uvacWarn) uvacWarn('Service worker no registrado:', err && err.message);
            });
        });
        // Versión nueva publicada: recargar en cuanto no haya llamada.
        // (La primera instalación también dispara controllerchange: esa no.)
        var hadController = !!navigator.serviceWorker.controller;
        var reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (!hadController) { hadController = true; return; }
            if (reloading || !navigator.serviceWorker.controller) return;
            var tryReload = function () {
                if (typeof UvacSIP !== 'undefined' && UvacSIP.currentSession) { setTimeout(tryReload, 5000); return; }
                reloading = true;
                location.reload();
            };
            tryReload();
        });
    }

    var deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        showHint('prompt');
    });
    window.addEventListener('appinstalled', function () { hideHint(true); });

    function hidden() {
        try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; }
    }

    function hideHint(remember) {
        var el = document.getElementById('installHint');
        if (el) el.remove();
        if (remember) { try { localStorage.setItem(HIDE_KEY, '1'); } catch (e) {} }
    }

    function showHint(kind) {
        if (standalone || hidden() || document.getElementById('installHint')) return;
        var box = document.querySelector('#loginScreen .login-box');
        if (!box) return;
        var el = document.createElement('div');
        el.id = 'installHint';
        el.className = 'install-hint';
        if (kind === 'ios') {
            el.innerHTML =
                '<div class="install-hint-title"><i class="ti ti-device-mobile"></i> Instala ALLEMM SIP en tu iPhone</div>' +
                '<ol>' +
                '<li>Toca <b>Compartir</b> <i class="ti ti-share-2"></i> en la barra de Safari.</li>' +
                '<li>Elige <b>Agregar a pantalla de inicio</b> <i class="ti ti-square-plus"></i>.</li>' +
                '<li>Abre la app desde el ícono <b>ALLEMM</b>.</li>' +
                '</ol>';
        } else {
            el.innerHTML =
                '<div class="install-hint-title"><i class="ti ti-download"></i> Instala ALLEMM SIP como app</div>' +
                '<button type="button" class="btn-primary install-hint-btn">Instalar app</button>';
            el.querySelector('.install-hint-btn').addEventListener('click', function () {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                deferredPrompt.userChoice.then(function (c) {
                    deferredPrompt = null;
                    if (c && c.outcome === 'accepted') hideHint(true);
                });
            });
        }
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'install-hint-close';
        close.title = 'No volver a mostrar';
        close.innerHTML = '<i class="ti ti-x"></i>';
        close.addEventListener('click', function () { hideHint(true); });
        el.appendChild(close);
        box.appendChild(el);
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (IS_IOS && !standalone) showHint('ios');
    });
})();
