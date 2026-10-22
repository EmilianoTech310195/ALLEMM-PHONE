/* ========================================
   ALLEMM SIP - Motor Web (JsSIP + WebSocket + WebRTC)
   ========================================
   En la WebApp (iPhone, Android sin APK, cualquier navegador) no hay PJSIP:
   el navegador no puede hablar SIP por UDP. Aquí el motor es JsSIP sobre
   WSS (WebSocket seguro) contra el mismo conmutador, y el audio va por WebRTC.

   Este archivo se presenta como window.pywebview.api — la misma forma que el
   .exe (Python) y el APK (android.js) — y manda los mismos eventos por
   AllemmBridge.dispatch, así sip.js, settings.js y app.js no cambian.

   Solo se incluye en la compilación web (web/build.py).
   ======================================== */
(function () {
    'use strict';
    if (window.AllemmAndroid) return;          // APK: manda android.js

    var VERSION = '1.0.0';
    var STORE_KEY = 'allemm_web_settings';
    var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var IS_MOBILE = IS_IOS || /Android|Mobile/i.test(navigator.userAgent);

    var DEFAULTS = {
        sipServer: 'pbx18879.pbxhosting.com.mx',
        sipPort: 8089,                  // puerto WSS del conmutador (no el 49999 UDP del .exe)
        wssPath: '/ws',
        transport: 'wss',
        registerExpires: 300,
        registerTimeout: 15,
        retryDelay: 5,
        maxRetries: 3,
        stunEnabled: true,              // WebRTC necesita STUN para salir del NAT
        stunServer: 'stun.l.google.com',
        stunPort: 19302,
        displayName: '',
        authUser: '',
        voicemailNumber: '',
        sessionTimers: false,
        captureDevice: '',
        playbackDevice: '',
        dtmfMode: 'INFO',
        keepScreenOn: false,
        appName: 'ALLEMM',
        companyName: 'ALLEMM',
        tagline: 'Tecnología que opera contigo',
        footerText: 'Ingresa tus credenciales SIP',
        historyRetentionDays: 6,
        callTimeout: 60,
        autoDial: true,
        monitorUrl: '',
        monitorToken: '',
        debug: false
    };
    // Cambian la cuenta/conexión: hay que volver a registrar.
    var REREGISTER_KEYS = ['sipServer', 'sipPort', 'wssPath', 'displayName', 'authUser',
        'registerExpires', 'sessionTimers'];

    /* ---------- Registro (log) en memoria, descargable desde Ajustes ---------- */
    var LOG = [];
    function log() {
        var parts = Array.prototype.map.call(arguments, function (a) {
            if (a instanceof Error) return a.name + ': ' + a.message;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
            return String(a);
        });
        LOG.push(new Date().toISOString() + ' ' + parts.join(' '));
        if (LOG.length > 3000) LOG.splice(0, LOG.length - 3000);
    }

    /* ---------- Ajustes (localStorage) ---------- */
    function loadSettings() {
        var s = {};
        try { s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { s = {}; }
        var out = {};
        Object.keys(DEFAULTS).forEach(function (k) { out[k] = (k in s) ? s[k] : DEFAULTS[k]; });
        return out;
    }
    function storeSettings(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { log('No se pudo guardar ajustes:', e); }
    }
    function normalize(s) {
        s.sipServer = String(s.sipServer || '').trim().replace(/^wss?:\/\//i, '').replace(/^sips?:/i, '').replace(/\/.*$/, '');
        s.sipPort = clampInt(s.sipPort, 1, 65535, DEFAULTS.sipPort);
        s.wssPath = '/' + String(s.wssPath || '/ws').trim().replace(/^\/+/, '');
        s.registerExpires = clampInt(s.registerExpires, 60, 3600, DEFAULTS.registerExpires);
        s.stunPort = clampInt(s.stunPort, 1, 65535, DEFAULTS.stunPort);
        s.dtmfMode = s.dtmfMode === 'RFC2833' ? 'RFC2833' : 'INFO';
        return s;
    }
    function clampInt(v, lo, hi, dflt) {
        var n = parseInt(v, 10);
        if (isNaN(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }
    function parseServer(text) {
        text = String(text || '').trim().replace(/^wss?:\/\//i, '').replace(/^sips?:/i, '').replace(/\/.*$/, '');
        if (!text) return null;
        var m = text.match(/^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/);
        if (!m || !/^[A-Za-z0-9.\-:]+$/.test(m[1])) return null;
        var port = m[2] ? parseInt(m[2], 10) : null;
        if (port !== null && (port < 1 || port > 65535)) return null;
        return { host: m[1], port: port };
    }

    var settings = normalize(loadSettings());

    /* ---------- Estado del motor ---------- */
    var JsSIPlib = window.JsSIP;
    var ua = null;
    var creds = null;               // {ext, pass}
    var registered = false;
    var session = null;
    var muted = false;
    var onHold = false;
    var pendingReregister = false;
    var regTimer = null;
    var hiddenSince = 0;
    var wakeLock = null;

    function emit(name, data) {
        log('⇒', name, data || {});
        var fire = function () {
            if (window.AllemmBridge) window.AllemmBridge.dispatch({ name: name, data: data || {} });
        };
        // Igual que el motor nativo: los eventos llegan fuera de la llamada al API.
        setTimeout(fire, 0);
    }

    function wssUrl() {
        return 'wss://' + settings.sipServer + ':' + settings.sipPort + settings.wssPath;
    }

    function iceServers() {
        if (!settings.stunEnabled || !settings.stunServer) return [];
        return [{ urls: 'stun:' + settings.stunServer + ':' + settings.stunPort }];
    }

    function pcConfig() {
        return { iceServers: iceServers(), iceTransportPolicy: 'all', rtcpMuxPolicy: 'require' };
    }

    /* ---------- Registro ---------- */
    function startUA() {
        stopUA();
        if (!creds) return;
        if (!JsSIPlib) { emit('engine_error', { message: 'No se cargó la librería JsSIP.' }); return; }
        try {
            if (settings.debug) {
                JsSIPlib.debug.enable('JsSIP:*');
                JsSIPlib.debug.log = function () { log.apply(null, ['[JsSIP]'].concat([].slice.call(arguments))); console.debug.apply(console, arguments); };
            } else {
                JsSIPlib.debug.disable();
            }
            var socket = new JsSIPlib.WebSocketInterface(wssUrl());
            ua = new JsSIPlib.UA({
                sockets: [socket],
                uri: 'sip:' + creds.ext + '@' + settings.sipServer,
                authorization_user: settings.authUser || creds.ext,
                password: creds.pass,
                realm: settings.sipServer,
                display_name: settings.displayName || creds.ext,
                register: true,
                register_expires: settings.registerExpires,
                session_timers: !!settings.sessionTimers,
                user_agent: 'ALLEMM SIP Web ' + VERSION,
                connection_recovery_min_interval: 2,
                connection_recovery_max_interval: 30
            });
        } catch (err) {
            log('No se pudo crear el UA:', err);
            emit('registration_failed', { cause: 'Connection Error', reason: err.message });
            return;
        }
        bindUA(ua);
        log('Conectando a', wssUrl(), 'como', creds.ext);
        emit('health', { state: 'warning' });
        ua.start();
        armRegisterTimeout();
    }

    function stopUA() {
        clearTimeout(regTimer);
        if (!ua) return;
        var old = ua;
        ua = null;
        try { old.removeAllListeners(); } catch (e) {}
        try { old.stop(); } catch (e) {}   // des-registra si estaba registrado
        if (registered) {
            registered = false;
            emit('unregistered', {});
        }
    }

    function armRegisterTimeout() {
        clearTimeout(regTimer);
        var me = ua;
        regTimer = setTimeout(function () {
            if (ua === me && !registered) {
                log('Sin registro después de', settings.registerTimeout, 's');
                emit('registration_failed', { cause: 'Connection Timeout' });
            }
        }, (settings.registerTimeout || 15) * 1000);
    }

    function bindUA(u) {
        u.on('connected', function () {
            if (u !== ua) return;
            log('WebSocket conectado');
            emit('health', { state: 'warning' });
        });
        u.on('disconnected', function (e) {
            if (u !== ua) return;
            log('WebSocket desconectado', e && e.error ? '(error)' : '', e && e.code || '');
            emit('health', { state: 'error' });
            if (registered) {
                registered = false;
                emit('unregistered', {});
            }
        });
        u.on('registered', function () {
            if (u !== ua) return;
            clearTimeout(regTimer);
            var first = !registered;
            registered = true;
            if (first) {
                log('Registrado en', settings.sipServer);
                emit('registered', {});
                listDevices();   // para usar el micrófono/altavoz elegidos en Ajustes
                updateWakeLock();
            }
        });
        u.on('unregistered', function () {
            if (u !== ua) return;
            if (registered) {
                registered = false;
                emit('unregistered', {});
            }
        });
        u.on('registrationFailed', function (e) {
            if (u !== ua) return;
            clearTimeout(regTimer);
            registered = false;
            var code = e && e.response ? e.response.status_code : null;
            log('Registro rechazado:', e.cause, code || '');
            if (code === 401 || code === 403 || e.cause === 'Authentication Error' || e.cause === 'Forbidden') {
                // No reintentar con una contraseña mala: el conmutador bloquea la IP
                // (Intrusion Detection) tras varios intentos fallidos.
                stopUA();
            }
            emit('registration_failed', { cause: e.cause || 'Connection Error', code: code,
                reason: e && e.response ? e.response.reason_phrase : '' });
        });
        u.on('newRTCSession', function (data) {
            if (u !== ua) return;
            if (data.originator === 'remote') onIncoming(data.session);
        });
    }

    /* ---------- Llamadas ---------- */
    function onIncoming(s) {
        var caller = '', display = '';
        try { caller = s.remote_identity.uri.user || ''; display = s.remote_identity.display_name || ''; } catch (e) {}
        if (session) {
            // Ocupado: el PBX la manda a otro compañero libre del grupo.
            log('Ocupado: segunda llamada rechazada (486) de', caller);
            try { s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch (e) {}
            return;
        }
        session = s;
        muted = false; onHold = false;
        bindSession(s);
        log('Llamada entrante de', caller, display);
        emit('incoming_call', { caller: caller, display: display });
    }

    function mediaConstraints() {
        var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (settings.captureDevice && deviceIds.input[settings.captureDevice]) {
            audio.deviceId = { exact: deviceIds.input[settings.captureDevice] };
        }
        return { audio: audio, video: false };
    }

    function bindSession(s) {
        s.on('progress', function () { if (s === session && s.direction === 'outgoing') emit('call_progress', {}); });
        s.on('accepted', function () { if (s === session) emit('call_answered', {}); });
        s.on('confirmed', function () { if (s === session) attachRemote(s); });
        s.on('peerconnection', function (e) { watchPeer(s, e.peerconnection); });
        s.on('icecandidate', iceReady);
        s.on('sdp', function (d) {
            if (d.originator === 'local') {
                try { d.sdp = filterCodecs(d.sdp); } catch (err) { log('No se pudo filtrar SDP:', err); }
            }
        });
        s.on('reinvite', function (d) { log('Re-INVITE del PBX'); if (d && d.callback) { try { d.callback(); } catch (e) {} } });
        s.on('peerconnection:setremotedescriptionfailed', function (e) {
            log('Re-INVITE ignorado:', e && e.error ? e.error.message : '');
        });
        s.on('ended', function (e) {
            if (s !== session) return;
            log('Llamada terminada:', e && e.cause, e && e.originator);
            finishCall();
            emit('call_ended', { cause: e && e.cause });
        });
        s.on('failed', function (e) {
            if (s !== session) return;
            var code = e && e.message && e.message.status_code;
            var reason = '';
            try { reason = (e.message && typeof e.message.getHeader === 'function') ? (e.message.getHeader('Reason') || '') : ''; } catch (err) {}
            var elsewhere = /completed elsewhere|answered elsewhere|cause=200/i.test(reason);
            var taken = s.direction === 'incoming' && e.originator === 'remote' &&
                (elsewhere || e.cause === 'Canceled');
            log('Llamada falló:', e.cause, code || '', reason, taken ? '(la tomó un compañero)' : '');
            finishCall();
            emit('call_failed', { cause: e.cause || 'Canceled', code: code || null, taken_by_colleague: taken });
        });
    }

    // JsSIP espera a que termine la recolección ICE antes de mandar el INVITE /
    // la respuesta; con STUN lento eso tardaba ~40 s. Basta el primer candidato
    // público (srflx) o 1.5 s.
    function iceReady(e) {
        var c = e && e.candidate;
        if (!c) return;
        if (c.type === 'srflx' || / typ srflx /.test(c.candidate || '')) { e.ready(); return; }
        if (!e.__timer) {
            setTimeout(function () { try { e.ready(); } catch (err) {} }, 1500);
            e.__timer = true;
        }
    }

    function watchPeer(s, pc) {
        pc.addEventListener('track', function (ev) {
            if (s === session) attachRemote(s, ev.streams && ev.streams[0]);
        });
        pc.addEventListener('iceconnectionstatechange', function () {
            log('ICE:', pc.iceConnectionState);
        });
    }

    function attachRemote(s, stream) {
        var el = document.getElementById('remoteAudio');
        if (!el) return;
        try {
            if (!stream && s.connection) {
                stream = new MediaStream();
                s.connection.getReceivers().forEach(function (r) { if (r.track) stream.addTrack(r.track); });
            }
            if (!stream) return;
            el.muted = false;
            el.volume = 1.0;
            el.setAttribute('playsinline', '');
            if (el.srcObject !== stream) el.srcObject = stream;
            applySpeakerDevice(el);
            var p = el.play();
            if (p && p.catch) p.catch(function (err) { log('No se pudo reproducir audio remoto:', err); });
        } catch (err) { log('Error conectando audio remoto:', err); }
    }

    function applySpeakerDevice(el) {
        if (!el.setSinkId || !settings.playbackDevice) return;
        var id = deviceIds.output[settings.playbackDevice];
        if (id) el.setSinkId(id).catch(function (err) { log('setSinkId falló:', err); });
    }

    function filterCodecs(sdp) {
        var lines = sdp.split('\r\n');
        var idx = lines.findIndex(function (l) { return l.indexOf('m=audio') === 0; });
        if (idx === -1) return sdp;
        var pref = ['opus', 'pcmu', 'pcma', 'telephone-event'];
        var map = {};
        lines.forEach(function (l) { var m = l.match(/^a=rtpmap:(\d+) ([^\/]+)\//); if (m) map[m[1]] = m[2].toLowerCase(); });
        var parts = lines[idx].split(' ');
        var keep = parts.slice(3).filter(function (p) { return pref.indexOf(map[p]) !== -1; });
        if (!keep.length) return sdp;
        keep.sort(function (a, b) { return pref.indexOf(map[a]) - pref.indexOf(map[b]); });
        lines[idx] = parts.slice(0, 3).concat(keep).join(' ');
        return lines.filter(function (l) {
            var m = l.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/);
            return !m || keep.indexOf(m[2]) !== -1;
        }).join('\r\n');
    }

    function finishCall() {
        session = null;
        muted = false;
        onHold = false;
        var el = document.getElementById('remoteAudio');
        if (el) { try { el.pause(); } catch (e) {} el.srcObject = null; }
        if (pendingReregister) {
            pendingReregister = false;
            setTimeout(function () { if (creds && !session) startUA(); }, 300);
        }
    }

    function target(number) {
        number = String(number || '').trim();
        if (/^sips?:/i.test(number)) return number;
        number = number.replace(/^(tel|callto):/i, '').replace(/[^\d*#+]/g, '');
        if (!number) return null;
        return 'sip:' + number + '@' + settings.sipServer;
    }

    function micError(err) {
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'MIC_DENIED';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'MIC_NOT_FOUND';
        return null;
    }

    /* ---------- Dispositivos de audio ---------- */
    var deviceIds = { input: {}, output: {} };
    function listDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
        return navigator.mediaDevices.enumerateDevices().then(function (list) {
            deviceIds = { input: {}, output: {} };
            var out = [];
            list.forEach(function (d, i) {
                if (!d.label || d.deviceId === 'default' || d.deviceId === 'communications') return;
                if (d.kind === 'audioinput') {
                    deviceIds.input[d.label] = d.deviceId;
                    out.push({ id: i, name: d.label, driver: 'navegador', inputCount: 1, outputCount: 0 });
                } else if (d.kind === 'audiooutput') {
                    deviceIds.output[d.label] = d.deviceId;
                    out.push({ id: i, name: d.label, driver: 'navegador', inputCount: 0, outputCount: 1 });
                }
            });
            return out;
        }).catch(function () { return []; });
    }

    /* ---------- Pantalla encendida (opcional) ---------- */
    function updateWakeLock() {
        var want = settings.keepScreenOn && registered && document.visibilityState === 'visible';
        if (!('wakeLock' in navigator)) return;
        if (want && !wakeLock) {
            navigator.wakeLock.request('screen').then(function (l) {
                wakeLock = l;
                l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
                log('Pantalla encendida: activo');
            }).catch(function (err) { log('Wake lock no disponible:', err); });
        } else if (!want && wakeLock) {
            var l = wakeLock; wakeLock = null;
            l.release().catch(function () {});
        }
    }

    /* ---------- Segundo plano (iPhone congela la página y mata el WebSocket) ---------- */
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            hiddenSince = Date.now();
            return;
        }
        updateWakeLock();
        if (!hiddenSince) return;            // no estuvo realmente en segundo plano
        var away = Date.now() - hiddenSince;
        hiddenSince = 0;
        if (!creds || session) return;
        if (!ua || !ua.isConnected() || away > 20000) {
            log('De vuelta en primer plano tras', Math.round(away / 1000), 's: reconectando');
            startUA();
        } else if (registered) {
            try { ua.register(); } catch (e) {}
        }
    });
    window.addEventListener('pagehide', function (e) {
        if (e.persisted || !ua) return;
        try { ua.stop(); } catch (err) {}
    });

    /* ---------- API (mismo contrato que pywebview / android.js) ---------- */
    var api = {
        app_info: function () {
            return {
                name: 'ALLEMM SIP', version: VERSION, platform: 'web',
                engineAvailable: !!JsSIPlib,
                transports: { udp: false, tcp: false, tls: false, wss: true },
                ios: IS_IOS, mobile: IS_MOBILE,
                micSelect: !IS_MOBILE && !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
                speakerSelect: !IS_MOBILE && typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
                wakeLock: 'wakeLock' in navigator,
                standalone: isStandalone()
            };
        },
        get_settings: function () { return Object.assign({}, settings); },
        save_settings: function (values) {
            var before = Object.assign({}, settings);
            var next = Object.assign({}, settings);
            Object.keys(values || {}).forEach(function (k) { if (k in DEFAULTS) next[k] = values[k]; });
            settings = normalize(next);
            storeSettings(settings);
            var changed = Object.keys(DEFAULTS).filter(function (k) {
                return JSON.stringify(before[k]) !== JSON.stringify(settings[k]);
            });
            var applied = 'saved';
            if (changed.indexOf('debug') !== -1 && JsSIPlib) {
                if (settings.debug) JsSIPlib.debug.enable('JsSIP:*'); else JsSIPlib.debug.disable();
            }
            if (changed.indexOf('keepScreenOn') !== -1) updateWakeLock();
            if (changed.indexOf('playbackDevice') !== -1) {
                var el = document.getElementById('remoteAudio');
                if (el && session) applySpeakerDevice(el);
            }
            var needsReg = changed.some(function (k) { return REREGISTER_KEYS.indexOf(k) !== -1; });
            if (needsReg && creds) {
                if (session) { pendingReregister = true; applied = 'busy'; }
                else { startUA(); applied = 'reregistered'; }
            }
            log('Ajustes guardados:', changed.join(',') || '(sin cambios)', '→', applied);
            var out = Object.assign({}, settings);
            out._applied = applied;
            return out;
        },
        list_audio_devices: function () { return listDevices(); },
        engine_status: function () {
            return {
                registered: registered, extension: creds ? creds.ext : '',
                inCall: !!session, incoming: !!(session && session.direction === 'incoming'),
                established: !!(session && session.isEstablished()),
                caller: session ? (function () { try { return session.remote_identity.uri.user; } catch (e) { return ''; } })() : ''
            };
        },
        get_launch_number: function () {
            // https://.../?llamar=2295125192  ó  #tel:2295125192
            var n = '';
            try {
                var q = new URLSearchParams(location.search);
                n = q.get('llamar') || q.get('call') || q.get('tel') || '';
                if (!n && /^#(tel|callto|sip):/i.test(location.hash)) n = decodeURIComponent(location.hash.slice(1));
                if (n) history.replaceState(null, '', location.pathname);
            } catch (e) {}
            return n;
        },
        sip_register: function (ext, pass, server) {
            ext = String(ext || '').trim();
            if (!ext || !pass) return { ok: false, cause: 'Authentication Error', error: 'Faltan datos' };
            if (server !== undefined && server !== null && String(server).trim() !== '') {
                var p = parseServer(server);
                if (!p) return { ok: false, cause: 'BAD_SERVER', error: 'Servidor inválido' };
                settings.sipServer = p.host;
                if (p.port) settings.sipPort = p.port;
                storeSettings(settings);
            }
            if (!JsSIPlib) return { ok: false, error: 'JsSIP no cargó' };
            creds = { ext: ext, pass: String(pass) };
            startUA();
            return { ok: true };
        },
        sip_unregister: function () {
            if (session) { try { session.terminate(); } catch (e) {} }
            creds = null;
            stopUA();
            updateWakeLock();
            return true;
        },
        sip_reconnect: function () {
            if (!creds) return false;
            startUA();
            return true;
        },
        sip_network_changed: function () {
            if (creds && !session) startUA();
            return true;
        },
        sip_call: function (number) {
            var t = target(number);
            if (!t || !ua || !registered || session) return false;
            try {
                session = ua.call(t, { mediaConstraints: mediaConstraints(), pcConfig: pcConfig(),
                    rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false } });
                muted = false; onHold = false;
                bindSession(session);
                // ua.call no pide el micrófono hasta después: los errores llegan por 'failed'
                log('Llamando a', t);
                return true;
            } catch (err) {
                log('ua.call falló:', err);
                session = null;
                var mic = micError(err);
                if (mic && window.UvacAlerts) UvacAlerts.show(mic);
                return false;
            }
        },
        sip_answer: function () {
            if (!session || session.direction !== 'incoming' || !session.isInProgress()) return false;
            try {
                session.answer({ mediaConstraints: mediaConstraints(), pcConfig: pcConfig() });
                return true;
            } catch (err) {
                log('answer falló:', err);
                var mic = micError(err);
                if (mic && window.UvacAlerts) UvacAlerts.show(mic);
                return false;
            }
        },
        sip_hangup: function () {
            if (!session) return false;
            try {
                if (session.isEstablished()) session.terminate();
                else if (session.direction === 'incoming') session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
                else session.terminate();
            } catch (err) {
                log('hangup falló:', err);
                finishCall();
                emit('call_ended', {});
            }
            return true;
        },
        sip_toggle_mute: function () {
            if (!session) return false;
            try {
                if (muted) session.unmute({ audio: true }); else session.mute({ audio: true });
                muted = !muted;
            } catch (err) { log('mute falló:', err); }
            return muted;
        },
        sip_hold: function (on) {
            if (!session || !session.isEstablished()) return false;
            on = (on === true || on === 'true');
            try {
                if (on && !onHold) { if (session.hold()) onHold = true; }
                else if (!on && onHold) { session.unhold(); onHold = false; }
            } catch (err) { log('hold falló:', err); }
            return onHold;
        },
        sip_transfer: function (number) {
            var t = target(number);
            if (!t || !session || !session.isEstablished()) return false;
            try {
                session.refer(t, {
                    eventHandlers: {
                        requestSucceeded: function () { emit('transfer_status', { code: 202, reason: 'Accepted', final: false }); },
                        requestFailed: function (e) {
                            var c = e && e.response ? e.response.status_code : 0;
                            emit('transfer_status', { code: c, reason: e && e.cause, final: true });
                            emit('engine_error', { message: 'El conmutador rechazó la transferencia (' + (c || e.cause) + ').' });
                        },
                        accepted: function () { emit('transfer_status', { code: 200, reason: 'OK', final: true }); },
                        failed: function (e) { emit('transfer_status', { code: e && e.status_line ? e.status_line.status_code : 0, reason: 'failed', final: true }); }
                    }
                });
                return true;
            } catch (err) {
                log('transfer falló:', err);
                return false;
            }
        },
        sip_dtmf: function (tone) {
            if (!session || !session.isEstablished()) return false;
            tone = String(tone || '');
            if (!/^[0-9A-D#*,]+$/i.test(tone)) return false;
            try {
                session.sendDTMF(tone, { transportType: settings.dtmfMode, duration: 160, interToneGap: 120 });
                return true;
            } catch (err) { log('DTMF falló:', err); return false; }
        },
        set_speaker: function () { return false; },
        open_log_folder: function () {
            var text = 'ALLEMM SIP Web ' + VERSION + '\n' + navigator.userAgent + '\n' +
                'Servidor: ' + wssUrl() + '\n\n' + LOG.join('\n') + '\n';
            var blob = new Blob([text], { type: 'text/plain' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'allemmsip-web-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
            return true;
        },
        monitor_report: function (payload) {
            if (!settings.monitorUrl) return false;
            var body = Object.assign({ token: settings.monitorToken }, payload || {});
            try {
                // no-cors: el panel recibe el POST aunque no mande cabeceras CORS.
                fetch(settings.monitorUrl, { method: 'POST', mode: 'no-cors', keepalive: true, body: JSON.stringify(body) })
                    .catch(function (err) { log('Panel de monitoreo no respondió:', err); });
            } catch (err) { log('monitor_report falló:', err); }
            return true;
        }
    };

    function isStandalone() {
        return window.navigator.standalone === true ||
            (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }

    // Cada método devuelve una promesa, igual que pywebview.
    var wrapped = {};
    Object.keys(api).forEach(function (k) {
        wrapped[k] = function () {
            var args = arguments;
            return new Promise(function (resolve, reject) {
                try { resolve(api[k].apply(null, args)); } catch (e) { reject(e); }
            });
        };
    });

    window.pywebview = { api: wrapped, platform: 'web' };
    window.ALLEMM_WEB = true;

    document.addEventListener('DOMContentLoaded', function () {
        document.body.classList.add('is-web');
        if (IS_IOS) document.body.classList.add('is-ios');
        if (isStandalone()) document.body.classList.add('is-standalone');

        // Copiar al log lo que la interfaz escribe en consola.
        ['uvacLog', 'uvacWarn', 'uvacError'].forEach(function (fn) {
            var orig = window[fn];
            if (typeof orig !== 'function') return;
            window[fn] = function () {
                log.apply(null, [fn === 'uvacLog' ? '[app]' : fn === 'uvacWarn' ? '[app⚠]' : '[app✖]'].concat([].slice.call(arguments)));
                return orig.apply(this, arguments);
            };
        });

        window.dispatchEvent(new Event('pywebviewready'));
    });

    log('Motor web listo', VERSION, navigator.userAgent);
})();
