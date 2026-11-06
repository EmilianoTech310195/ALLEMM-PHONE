/* ========================================
   ALLEMM SIP Web - Ajustes
   ========================================
   Modal de ajustes (conmutador WSS, STUN, audio, DTMF, soporte). Los
   valores los guarda el motor web (web-engine.js) en este navegador; los
   de la empresa vienen de js/allemm-config.js.
   ======================================== */

const AllemmSettings = {
    current: null,
    info: {},

    init: function () {
        const self = this;
        const modal = document.getElementById('settingsModal');
        if (!modal) return;

        ['settingsBtn', 'settingsBtnApp'].forEach(function (id) {
            const b = document.getElementById(id);
            if (b) b.addEventListener('click', function (e) { e.preventDefault(); self.open(); });
        });
        document.getElementById('settingsCancelBtn').addEventListener('click', function () { self.close(); });
        document.getElementById('settingsSaveBtn').addEventListener('click', function () { self.save(); });
        document.getElementById('settingsLogBtn').addEventListener('click', function () {
            AllemmBridge.call('download_log').catch(function () {});
        });
        modal.addEventListener('click', function (e) { if (e.target === modal) self.close(); });
        document.getElementById('setStun').addEventListener('change', function () { self._refreshRows(); });
        this._setupVoicemailKey();

        this._whenReady(function () { self._afterEngineReady(); });
    },

    _whenReady: function (fn) {
        if (window.AllemmEngine) { fn(); return; }
        window.addEventListener('allemmengineready', fn, { once: true });
    },

    _afterEngineReady: function () {
        const self = this;
        AllemmBridge.ready = true;
        AllemmBridge.call('get_settings').then(function (s) {
            self.current = s;
            self._applyToUI(s);
        }).catch(function (err) { allemmError('get_settings falló:', err); });

        AllemmBridge.call('app_info').then(function (info) {
            self.info = info || {};
            const v = document.querySelector('.footer .version');
            if (v) v.textContent = '· ' + info.name + ' v' + info.version;
            if (!info.engineAvailable) {
                AllemmAlerts.show('UNKNOWN', { details: 'No se pudo cargar el motor SIP (JsSIP). Recarga la página.' });
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
                if (typeof AllemmApp !== 'undefined' && !AllemmApp.isInCall) AllemmApp._makeCall();
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
        if (typeof ALLEMM_CONFIG !== 'undefined') {
            ALLEMM_CONFIG.sipServer = s.sipServer || ALLEMM_CONFIG.sipServer;
            ALLEMM_CONFIG.dtmfMode = s.dtmfMode || ALLEMM_CONFIG.dtmfMode;
            ALLEMM_CONFIG.maxRetries = s.maxRetries;
            ALLEMM_CONFIG.retryDelay = s.retryDelay;
            ALLEMM_CONFIG.registerTimeout = s.registerTimeout;
            ALLEMM_CONFIG.historyRetentionDays = s.historyRetentionDays;
            ALLEMM_CONFIG.debug = !!s.debug;
        }
        if (typeof AllemmReporter !== 'undefined') {
            AllemmReporter.url = s.monitorUrl || '';
            AllemmReporter.token = s.monitorToken || '';
        }
        if (typeof AllemmApp !== 'undefined') {
            AllemmApp.AUTO_DIAL = s.autoDial !== false;
        }
        const serverInput = document.getElementById('sipServer');
        if (serverInput && s.sipServer && !serverInput.value) {
            serverInput.value = s.sipServer + (s.sipPort ? ':' + s.sipPort : '');
        }
        document.querySelectorAll('[data-brand="appName"]').forEach(function (el) { el.textContent = s.appName || ''; });
        document.querySelectorAll('[data-brand="footerText"]').forEach(function (el) { el.textContent = s.footerText || ''; });
        document.querySelectorAll('[data-brand="tagline"]').forEach(function (el) { el.textContent = s.tagline || ''; });
        if (s.appName) document.title = s.appName + ' SIP';
    },

    open: function () {
        const self = this;
        document.getElementById('settingsModal').classList.remove('hidden');
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
        const v = function (id, val) { document.getElementById(id).value = val; };
        const c = function (id, val) { document.getElementById(id).checked = !!val; };
        v('setServer', s.sipServer || '');
        v('setPort', s.sipPort || 8089);
        v('setWssPath', s.wssPath || '/ws');
        v('setDisplayName', s.displayName || '');
        v('setAuthUser', s.authUser || '');
        v('setVoicemail', s.voicemailNumber || '');
        v('setExpires', s.registerExpires || 300);
        c('setStun', s.stunEnabled);
        v('setStunServer', s.stunServer || 'stun.l.google.com');
        v('setStunPort', s.stunPort || 19302);
        c('setKeepScreen', s.keepScreenOn);
        v('setDtmf', s.dtmfMode || 'INFO');
        c('setDebug', s.debug);
        v('setMonitorUrl', s.monitorUrl || '');
        v('setMonitorToken', s.monitorToken || '');
        this._refreshRows();
    },

    /** Mostrar solo lo que este navegador puede usar. */
    _refreshRows: function () {
        const info = this.info || {};
        const show = function (cls, on) {
            document.querySelectorAll('#settingsModal .' + cls).forEach(function (el) { el.classList.toggle('row-hidden', !on); });
        };
        show('row-stun', document.getElementById('setStun').checked);
        show('row-wakelock', !!info.wakeLock);
        show('row-mic', !!info.micSelect);     // celulares: el sistema elige
        show('row-spk', !!info.speakerSelect); // solo navegadores que dejan elegir salida
    },

    _fillDevices: function (devices) {
        if (!Array.isArray(devices)) devices = [];
        const mic = document.getElementById('setMic');
        const spk = document.getElementById('setSpeaker');
        const cur = this.current || {};
        [mic, spk].forEach(function (sel) { sel.innerHTML = '<option value="">Predeterminado del sistema</option>'; });
        devices.forEach(function (d) {
            const o = document.createElement('option');
            o.value = d.name; o.textContent = d.name;
            (d.inputCount > 0 ? mic : spk).appendChild(o);
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
            sipPort: parseInt(val('setPort'), 10) || 8089,
            wssPath: val('setWssPath') || '/ws',
            displayName: val('setDisplayName'),
            authUser: val('setAuthUser'),
            voicemailNumber: val('setVoicemail'),
            registerExpires: parseInt(val('setExpires'), 10) || 300,
            stunEnabled: chk('setStun'),
            stunServer: val('setStunServer'),
            stunPort: parseInt(val('setStunPort'), 10) || 19302,
            keepScreenOn: chk('setKeepScreen'),
            captureDevice: document.getElementById('setMic').value,
            playbackDevice: document.getElementById('setSpeaker').value,
            dtmfMode: document.getElementById('setDtmf').value,
            debug: chk('setDebug'),
            monitorUrl: val('setMonitorUrl'),
            monitorToken: val('setMonitorToken')
        };
        if (!values.sipServer) { this._status('El conmutador es obligatorio.', 'error'); return; }
        if (values.stunEnabled && !values.stunServer) { this._status('Escribe el servidor STUN o desactívalo.', 'error'); return; }
        const msgs = {
            reregistered: 'Guardado y aplicado: se volvió a registrar con los datos nuevos.',
            busy: 'Guardado. Se aplicará al terminar la llamada en curso.',
            saved: 'Guardado y aplicado.'
        };
        AllemmBridge.call('save_settings', values).then(function (s) {
            self.current = s;
            self._applyToUI(s);
            const applied = (s && s._applied) || 'saved';
            self._status(msgs[applied] || msgs.saved, 'success');
            setTimeout(function () { self.close(); }, 1400);
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
