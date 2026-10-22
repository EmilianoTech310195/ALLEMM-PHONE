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
        ['setTransport', 'setStun'].forEach(function (id) {
            document.getElementById(id).addEventListener('change', function () { self._refreshRows(); });
        });
        this._setupVoicemailKey();

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
            self.info = info || {};
            const v = document.querySelector('.footer .version');
            const plat = { android: ' · Android', web: ' · Web' }[info.platform] || ' · escritorio';
            if (v) v.textContent = '· ' + info.name + ' v' + info.version + plat;
            if (!info.engineAvailable) {
                UvacAlerts.show('UNKNOWN', {
                    details: info.platform === 'web'
                        ? 'No se pudo cargar el motor SIP (JsSIP). Recarga la página.'
                        : 'El motor SIP (pjsua2) no está compilado en esta instalación. ' +
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

    /** Buzón de voz: mantener presionado el 1 marca el número configurado (como en un teléfono). */
    _setupVoicemailKey: function () {
        const self = this;
        const key = document.querySelector('#keypad .dial-key[data-key="1"]');
        if (!key) return;
        let timer = null, fired = false;
        const start = function () {
            fired = false;
            clearTimeout(timer);
            timer = setTimeout(function () {
                const n = (self.current && self.current.voicemailNumber) || '';
                if (!n) return;
                fired = true;
                if (navigator.vibrate) navigator.vibrate(40);
                const d = document.getElementById('numberDisplay');
                if (d) d.value = n;
                if (typeof UvacApp !== 'undefined' && !UvacApp.isInCall) UvacApp._makeCall();
            }, 700);
        };
        const stop = function () { clearTimeout(timer); };
        key.addEventListener('pointerdown', start);
        key.addEventListener('pointerup', stop);
        key.addEventListener('pointerleave', stop);
        key.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        // Si fue pulsación larga, que no se agregue también un "1" al número.
        key.addEventListener('click', function (e) {
            if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
        }, true);
    },

    _markVoicemail: function (s) {
        const letters = document.querySelector('#keypad .dial-key[data-key="1"] .letters');
        if (letters) letters.innerHTML = (s && s.voicemailNumber) ? '<i class="ti ti-voicemail"></i>' : '';
    },

    _applyToUI: function (s) {
        this._markVoicemail(s);
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
        AllemmBridge.call('app_info').then(function (info) { self.info = info || self.info; self._refreshRows(); }).catch(function () {});
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
        const v = function (id, val) { document.getElementById(id).value = val; };
        const c = function (id, val) { document.getElementById(id).checked = !!val; };
        v('setServer', s.sipServer || '');
        v('setPort', s.sipPort || 5060);
        v('setDisplayName', s.displayName || '');
        v('setAuthUser', s.authUser || '');
        v('setProxy', s.outboundProxy || '');
        v('setWssPath', s.wssPath || '/ws');
        c('setKeepScreen', s.keepScreenOn);
        v('setVoicemail', s.voicemailNumber || '');
        v('setExpires', s.registerExpires || 300);
        v('setTransport', s.transport || 'udp');
        c('setFallback', s.autoTransportFallback !== false);
        c('setTlsVerify', s.tlsVerify);
        c('setStun', s.stunEnabled);
        v('setStunServer', s.stunServer || 'stun.l.google.com');
        v('setStunPort', s.stunPort || 19302);
        c('setMobileData', s.allowMobileData !== false);
        v('setDtmf', s.dtmfMode || 'INFO');
        v('setSrtp', s.srtp || 'off');
        c('setDebug', s.debug);
        v('setMonitorUrl', s.monitorUrl || '');
        v('setMonitorToken', s.monitorToken || '');
        this._refreshRows();
    },

    /** Mostrar solo lo que aplica: nada de opciones que no hacen nada. */
    _refreshRows: function () {
        const info = this.info || {};
        const web = info.platform === 'web';
        const tr = info.transports || { udp: true, tcp: true, tls: false };
        const sel = document.getElementById('setTransport');
        Array.prototype.forEach.call(sel.options, function (o) {
            const ok = tr[o.value] !== false;
            o.disabled = !ok;
            if (o.value === 'tls') o.textContent = ok ? 'TLS (cifrado)' : 'TLS (no disponible en esta versión)';
        });
        if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = 'udp';
        const show = function (cls, on) {
            document.querySelectorAll('#settingsModal .' + cls).forEach(function (el) { el.classList.toggle('row-hidden', !on); });
        };
        show('row-fallback', !web && sel.value === 'udp' && tr.tcp !== false);
        show('row-tls', !web && sel.value === 'tls');
        show('row-stun', document.getElementById('setStun').checked);
        show('row-android', info.platform === 'android');
        show('row-desktop', info.platform !== 'android' && !web);
        // Web (WSS + WebRTC): sin transporte/proxy/SRTP (el navegador siempre cifra);
        // micrófono/altavoz solo donde el navegador deja elegirlos.
        show('row-native', !web);
        show('row-web', web);
        if (web) {
            show('row-wakelock', !!info.wakeLock);
            show('row-mic', !!info.micSelect);
            show('row-spk', !!info.speakerSelect);
        }
        const portLabel = document.getElementById('setPortLabel');
        if (portLabel) portLabel.textContent = web ? 'Puerto WSS' : 'Puerto';
    },

    _fillDevices: function (devices) {
        if (!Array.isArray(devices)) devices = [];
        if ((this.info || {}).platform === 'android') return;   // Android elige auricular/altavoz solo
        const mic = document.getElementById('setMic');
        const spk = document.getElementById('setSpeaker');
        const cur = this.current || {};
        const dflt = (this.info || {}).platform === 'web' ? 'Predeterminado del sistema' : 'Predeterminado de Windows';
        [mic, spk].forEach(function (sel) { sel.innerHTML = '<option value="">' + dflt + '</option>'; });
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
        const val = function (id) { return document.getElementById(id).value.trim(); };
        const chk = function (id) { return document.getElementById(id).checked; };
        const values = {
            sipServer: val('setServer'),
            sipPort: parseInt(val('setPort'), 10) || 5060,
            displayName: val('setDisplayName'),
            authUser: val('setAuthUser'),
            outboundProxy: val('setProxy'),
            voicemailNumber: val('setVoicemail'),
            registerExpires: parseInt(val('setExpires'), 10) || 300,
            transport: document.getElementById('setTransport').value,
            autoTransportFallback: chk('setFallback'),
            tlsVerify: chk('setTlsVerify'),
            stunEnabled: chk('setStun'),
            stunServer: val('setStunServer'),
            stunPort: parseInt(val('setStunPort'), 10) || 3478,
            allowMobileData: chk('setMobileData'),
            dtmfMode: document.getElementById('setDtmf').value,
            srtp: document.getElementById('setSrtp').value,
            debug: chk('setDebug'),
            monitorUrl: val('setMonitorUrl'),
            monitorToken: val('setMonitorToken')
        };
        if ((self.info || {}).platform !== 'android') {
            values.captureDevice = document.getElementById('setMic').value;
            values.playbackDevice = document.getElementById('setSpeaker').value;
        }
        if ((self.info || {}).platform === 'web') {
            values.wssPath = val('setWssPath') || '/ws';
            values.keepScreenOn = chk('setKeepScreen');
            ['transport', 'autoTransportFallback', 'tlsVerify', 'outboundProxy', 'srtp', 'allowMobileData']
                .forEach(function (k) { delete values[k]; });
        }
        if (!values.sipServer) { this._status('El servidor SIP es obligatorio.', 'error'); return; }
        if (values.stunEnabled && !values.stunServer) { this._status('Escribe el servidor STUN o desactívalo.', 'error'); return; }
        if (values.monitorUrl && !/^https?:\/\//i.test(values.monitorUrl)) {
            this._status('La URL del panel debe empezar con http:// o https://', 'error'); return;
        }
        const msgs = {
            restarted: 'Guardado y aplicado: el motor se reinició y volvió a registrar.',
            reregistered: 'Guardado y aplicado: se volvió a registrar con los datos nuevos.',
            busy: 'Guardado. Se aplicará al terminar la llamada en curso.',
            error: 'Guardado, pero no se pudo aplicar al motor. Revisa el log.',
            saved: 'Guardado y aplicado.'
        };
        AllemmBridge.call('save_settings', values).then(function (s) {
            self.current = s;
            self._applyToUI(s);
            const applied = (s && s._applied) || 'saved';
            self._status(msgs[applied] || msgs.saved, applied === 'error' ? 'error' : 'success');
            if (applied !== 'error') setTimeout(function () { self.close(); }, 1400);
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
