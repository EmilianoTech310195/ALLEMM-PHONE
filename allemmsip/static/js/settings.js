/* ========================================
   ALLEMM SIP - Ajustes de escritorio
   ========================================
   Modal de ajustes (servidor, transporte, audio, DTMF) guardado por el
   motor en settings.json. También arranca el click-to-call cuando la app
   se abre con un número (AllemmSIP.exe 2295125192 / tel:...).
   ======================================== */

const AllemmSettings = {
    current: null,

    init: function () {
        const self = this;
        const openBtn = document.getElementById('settingsBtn');
        const openBtn2 = document.getElementById('settingsBtnApp');
        const modal = document.getElementById('settingsModal');
        if (!modal) return;

        [openBtn, openBtn2].forEach(function (b) {
            if (b) b.addEventListener('click', function () { self.open(); });
        });
        document.getElementById('settingsCancelBtn').addEventListener('click', function () { self.close(); });
        document.getElementById('settingsSaveBtn').addEventListener('click', function () { self.save(); });
        document.getElementById('settingsLogBtn').addEventListener('click', function () {
            AllemmBridge.call('open_log_folder').catch(function () {});
        });
        modal.addEventListener('click', function (e) { if (e.target === modal) self.close(); });

        this._whenReady(function () { self._afterBridgeReady(); });
    },

    _whenReady: function (fn) {
        if (window.pywebview && window.pywebview.api) { fn(); return; }
        window.addEventListener('pywebviewready', fn, { once: true });
        // Fuera de pywebview (abriendo el HTML en un navegador) no hay motor:
        setTimeout(function () {
            if (!(window.pywebview && window.pywebview.api)) {
                uvacWarn('Sin API nativo: ¿abriste index.html fuera de la aplicación?');
            }
        }, 3000);
    },

    _afterBridgeReady: function () {
        const self = this;
        AllemmBridge.ready = true;
        AllemmBridge.call('get_settings').then(function (s) {
            self.current = s;
            self._applyToUI(s);
        }).catch(function (err) { uvacError('get_settings falló:', err); });

        AllemmBridge.call('app_info').then(function (info) {
            const v = document.querySelector('.footer .version');
            if (v) v.textContent = '· ' + info.name + ' v' + info.version + ' · escritorio';
            if (!info.engineAvailable) {
                UvacAlerts.show('UNKNOWN', {
                    details: 'El motor SIP (pjsua2) no está compilado en esta instalación. ' +
                             'Ejecuta tools\\build-pjsip-windows.ps1 y vuelve a compilar.'
                });
            }
        }).catch(function () {});

        AllemmBridge.call('get_launch_number').then(function (n) {
            if (n && typeof UvacApp !== 'undefined') {
                uvacLog('🔗 Número recibido al abrir:', n);
                UvacApp.pendingAutoCall = String(n);
                UvacApp.autoCallDone = false;
                UvacApp._handleAutoCall(0);
            }
        }).catch(function () {});
    },

    _applyToUI: function (s) {
        // Datos de marca y de comportamiento que antes vivían en config.js
        if (typeof UVAC_CONFIG !== 'undefined') {
            UVAC_CONFIG.sipServer = s.sipServer || UVAC_CONFIG.sipServer;
            UVAC_CONFIG.dtmfMode = s.dtmfMode || UVAC_CONFIG.dtmfMode;
            UVAC_CONFIG.maxRetries = s.maxRetries;
            UVAC_CONFIG.retryDelay = s.retryDelay;
            UVAC_CONFIG.registerTimeout = s.registerTimeout;
            UVAC_CONFIG.historyRetentionDays = s.historyRetentionDays;
            UVAC_CONFIG.debug = !!s.debug;
        }
        if (typeof UvacReporter !== 'undefined') {
            UvacReporter.url = s.monitorUrl || '';
            UvacReporter.token = s.monitorToken || '';
        }
        if (typeof UvacApp !== 'undefined') {
            UvacApp.AUTO_DIAL = s.autoDial !== false;
        }
        const serverInput = document.getElementById('sipServer');
        if (serverInput && s.sipServer) {
            const port = (s.sipPort && s.sipPort !== 5060) ? ':' + s.sipPort : '';
            serverInput.value = s.sipServer + port;
        }
        document.querySelectorAll('[data-brand="appName"]').forEach(function (el) { el.textContent = s.appName || ''; });
        document.querySelectorAll('[data-brand="footerText"]').forEach(function (el) { el.textContent = s.footerText || ''; });
        document.querySelectorAll('[data-brand="tagline"]').forEach(function (el) { el.textContent = s.tagline || ''; });
        if (s.appName) document.title = s.appName + ' SIP';
    },

    open: function () {
        const self = this;
        const modal = document.getElementById('settingsModal');
        modal.classList.remove('hidden');
        this._status('', '');
        AllemmBridge.call('get_settings').then(function (s) {
            self.current = s;
            self._fill(s);
            return AllemmBridge.call('list_audio_devices');
        }).then(function (devices) {
            self._fillDevices(devices || []);
        }).catch(function (err) {
            self._status('No se pudo leer la configuración: ' + err.message, 'error');
        });
    },

    close: function () {
        document.getElementById('settingsModal').classList.add('hidden');
    },

    _fill: function (s) {
        document.getElementById('setServer').value = s.sipServer || '';
        document.getElementById('setPort').value = s.sipPort || 5060;
        document.getElementById('setTransport').value = s.transport || 'udp';
        document.getElementById('setDtmf').value = s.dtmfMode || 'INFO';
        document.getElementById('setSrtp').value = s.srtp || 'optional';
        document.getElementById('setStun').checked = s.stunEnabled !== false;
        document.getElementById('setFallback').checked = s.autoTransportFallback !== false;
        document.getElementById('setExpires').value = s.registerExpires || 600;
        document.getElementById('setMonitorUrl').value = s.monitorUrl || '';
        document.getElementById('setMonitorToken').value = s.monitorToken || '';
        document.getElementById('setDebug').checked = !!s.debug;
    },

    _fillDevices: function (devices) {
        const mic = document.getElementById('setMic');
        const spk = document.getElementById('setSpeaker');
        const cur = this.current || {};
        [mic, spk].forEach(function (sel) { sel.innerHTML = '<option value="">Predeterminado de Windows</option>'; });
        devices.forEach(function (d) {
            if (d.inputCount > 0) {
                const o = document.createElement('option');
                o.value = d.name; o.textContent = d.name + ' (' + d.driver + ')';
                mic.appendChild(o);
            }
            if (d.outputCount > 0) {
                const o = document.createElement('option');
                o.value = d.name; o.textContent = d.name + ' (' + d.driver + ')';
                spk.appendChild(o);
            }
        });
        mic.value = cur.captureDevice || '';
        spk.value = cur.playbackDevice || '';
    },

    save: function () {
        const self = this;
        const values = {
            sipServer: document.getElementById('setServer').value.trim(),
            sipPort: parseInt(document.getElementById('setPort').value, 10) || 5060,
            transport: document.getElementById('setTransport').value,
            dtmfMode: document.getElementById('setDtmf').value,
            srtp: document.getElementById('setSrtp').value,
            stunEnabled: document.getElementById('setStun').checked,
            autoTransportFallback: document.getElementById('setFallback').checked,
            registerExpires: parseInt(document.getElementById('setExpires').value, 10) || 600,
            captureDevice: document.getElementById('setMic').value,
            playbackDevice: document.getElementById('setSpeaker').value,
            monitorUrl: document.getElementById('setMonitorUrl').value.trim(),
            monitorToken: document.getElementById('setMonitorToken').value.trim(),
            debug: document.getElementById('setDebug').checked
        };
        if (!values.sipServer) {
            this._status('El servidor SIP es obligatorio.', 'error');
            return;
        }
        AllemmBridge.call('save_settings', values).then(function (s) {
            self.current = s;
            self._applyToUI(s);
            self._status('Guardado. Si cambiaste servidor o transporte, vuelve a conectar.', 'success');
            setTimeout(function () { self.close(); }, 900);
        }).catch(function (err) {
            self._status('No se pudo guardar: ' + err.message, 'error');
        });
    },

    _status: function (msg, type) {
        const el = document.getElementById('settingsStatus');
        if (!el) return;
        el.textContent = msg;
        el.className = type ? 'login-status ' + type : 'login-status';
    }
};

document.addEventListener('DOMContentLoaded', function () { AllemmSettings.init(); });
