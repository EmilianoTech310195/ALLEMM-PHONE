/* ========================================
   ALLEMM SIP Web - Capa de llamadas
   ========================================
   Lo que usa la interfaz (app.js) para llamar:

     AllemmSIP.init(ext, pass) / reconnect() / disconnect()
     AllemmSIP.makeCall(n) / answer() / hangup() / toggleMute()
     AllemmSIP.transfer(n) / sendDTMF(t) / hold(on)
     AllemmSIP.onRegistered / onRegistrationFailed / onUnregistered
     AllemmSIP.onIncomingCall / onCallProgress / onCallAnswered
     AllemmSIP.onCallEnded / onCallFailed

   Por debajo el motor web (web-engine.js: JsSIP sobre WSS + WebRTC)
   expone window.AllemmEngine y avisa sus eventos por
   AllemmBridge.dispatch({name, data}).
   ======================================== */

const AllemmBridge = {
    ready: false,
    _queue: [],
    _handlers: {},

    on: function (name, fn) {
        this._handlers[name] = fn;
    },

    dispatch: function (evt) {
        try {
            const fn = this._handlers[evt.name];
            allemmLog('⇐ motor:', evt.name, evt.data || {});
            if (fn) fn(evt.data || {});
        } catch (err) {
            allemmError('Error procesando evento ' + (evt && evt.name) + ':', err);
        }
    },

    api: function () {
        return window.AllemmEngine || null;
    },

    /** Llama a un método del motor web. Devuelve una promesa. */
    call: function (method) {
        const args = Array.prototype.slice.call(arguments, 1);
        const api = this.api();
        if (!api || typeof api[method] !== 'function') {
            return Promise.reject(new Error('Motor web no disponible: ' + method));
        }
        try {
            return Promise.resolve(api[method].apply(api, args));
        } catch (err) {
            return Promise.reject(err);
        }
    }
};

window.AllemmBridge = AllemmBridge;

/* Sesión "falsa" con la misma forma que usaba app.js (JsSIP RTCSession). */
function AllemmSession(direction) {
    this.direction = direction;
    this.established = false;
}
AllemmSession.prototype.isEstablished = function () { return this.established; };
AllemmSession.prototype.isInProgress = function () { return !this.established; };

const AllemmSIP = {

    // Estado (mismos nombres que la versión web)
    ua: { isConnected: function () { return AllemmSIP.isRegistered; } },
    currentSession: null,
    isRegistered: false,
    isMuted: false,
    callStartTime: null,
    timerInterval: null,

    savedExtension: null,
    savedPassword: null,

    retryCount: 0,
    isRetrying: false,
    _answerAttempted: false,

    // Callbacks que asigna app.js
    onRegistered: null,
    onUnregistered: null,
    onRegistrationFailed: null,
    onIncomingCall: null,
    onCallProgress: null,
    onCallAnswered: null,
    onCallEnded: null,
    onCallFailed: null,

    /** Registrar en el PBX (login). */
    init: function (extension, password) {
        allemmLog('Iniciando sesión con la extensión:', extension);
        if (!AllemmAlerts.preflightCheck()) return false;

        this.savedExtension = extension;
        this.savedPassword = password;
        return this._connect();
    },

    _connect: function () {
        const self = this;
        AllemmAlerts.setHealth('warning');
        // Conmutador capturado en el login (host o host:puerto WSS).
        const serverInput = document.getElementById('sipServer');
        const server = serverInput ? serverInput.value.trim() : '';
        AllemmBridge.call('sip_register', this.savedExtension, this.savedPassword, server)
            .then(function (res) {
                if (res && res.ok === false) {
                    allemmError('Registro rechazado por el motor:', res.error);
                    AllemmAlerts.setHealth('error');
                    if (self.onRegistrationFailed) self.onRegistrationFailed('Connection Error');
                }
            })
            .catch(function (err) {
                allemmError('No se pudo iniciar el registro:', err);
                AllemmAlerts.setHealth('error');
                if (self.onRegistrationFailed) self.onRegistrationFailed('Connection Error');
            });
        return true;
    },

    /** Reconectar manualmente (botón "Reintentar"). */
    reconnect: function () {
        allemmLog('🔄 Reconectando...');
        AllemmAlerts.setHealth('warning');
        if (!this.savedExtension) return;
        AllemmBridge.call('sip_reconnect').catch(function (err) {
            allemmError('reconnect falló:', err);
        });
    },

    /** Desconectar (cerrar sesión). */
    disconnect: function () {
        if (this.currentSession) this.hangup();
        this.isRegistered = false;
        this.savedExtension = null;
        this.savedPassword = null;
        this._cleanup();
        AllemmAlerts.setHealth('offline');
        AllemmBridge.call('sip_unregister').catch(function () {});
    },

    /** Llamar. */
    makeCall: function (number) {
        const self = this;
        if (!this.isRegistered) {
            allemmError('No registrado, no se puede llamar');
            AllemmAlerts.show('WS_DISCONNECTED', {
                autoRetry: true,
                retryCallback: function () { self.reconnect(); }
            });
            return false;
        }
        if (this.currentSession) {
            allemmError('Ya hay una llamada activa');
            return false;
        }
        try { if (typeof AllemmRingback !== 'undefined') AllemmRingback.preload(); } catch (e) {}

        this.currentSession = new AllemmSession('outgoing');
        this.isMuted = false;
        AllemmBridge.call('sip_call', number).then(function (ok) {
            if (!ok) {
                allemmError('El motor no pudo iniciar la llamada');
                self._cleanup();
                AllemmAlerts.show('CALL_FAILED', { details: { cause: 'engine' } });
                if (self.onCallFailed) self.onCallFailed('Rejected');
            }
        }).catch(function (err) {
            allemmError('sip_call falló:', err);
            self._cleanup();
            if (self.onCallFailed) self.onCallFailed('Rejected');
        });
        allemmLog('📞 Llamando a:', number);
        return true;
    },

    /** Contestar llamada entrante. */
    answer: function () {
        if (!this.currentSession) return false;
        if (this._answerAttempted) {
            allemmLog('answer() ignorado: ya se está contestando');
            return false;
        }
        this._answerAttempted = true;
        AllemmBridge.call('sip_answer').catch(function (err) { allemmError('answer falló:', err); });
        return true;
    },

    /** Colgar / rechazar. */
    hangup: function () {
        if (!this.currentSession) return false;
        AllemmBridge.call('sip_hangup').catch(function (err) { allemmError('hangup falló:', err); });
        return true;
    },

    /** Silenciar / activar micrófono. Devuelve el nuevo estado (true = muted). */
    toggleMute: function () {
        if (!this.currentSession) return false;
        const self = this;
        this.isMuted = !this.isMuted;   // respuesta inmediata para la UI
        AllemmBridge.call('sip_toggle_mute').then(function (muted) {
            self.isMuted = !!muted;
        }).catch(function (err) { allemmError('mute falló:', err); });
        return this.isMuted;
    },

    /** Transferencia ciega. */
    transfer: function (number) {
        if (!this.currentSession || !this.currentSession.isEstablished()) {
            allemmError('No hay llamada activa para transferir');
            return false;
        }
        AllemmBridge.call('sip_transfer', number).then(function (ok) {
            if (!ok) AllemmAlerts.show('UNKNOWN', { details: 'El motor rechazó la transferencia' });
        }).catch(function (err) {
            AllemmAlerts.show('UNKNOWN', { details: 'Error al transferir: ' + err.message });
        });
        allemmLog('Transferida a:', number);
        return true;
    },

    /** Tono DTMF durante la llamada (INFO o RFC2833 según ajustes). */
    sendDTMF: function (tone) {
        if (!this.currentSession || !this.currentSession.isEstablished()) {
            allemmWarn('DTMF NO enviado (no hay llamada establecida):', tone);
            return false;
        }
        AllemmBridge.call('sip_dtmf', tone).catch(function (err) { allemmError('DTMF falló:', err); });
        allemmLog('DTMF enviado:', tone);
        return true;
    },

    /** Retener / reanudar. */
    hold: function (on) {
        if (!this.currentSession || !this.currentSession.isEstablished()) return false;
        AllemmBridge.call('sip_hold', !!on).catch(function (err) { allemmError('hold falló:', err); });
        return true;
    },

    _startCallTimer: function () {
        const self = this;
        this._stopCallTimer();
        this.timerInterval = setInterval(function () {
            if (!self.callStartTime) return;
            const secs = Math.floor((Date.now() - self.callStartTime) / 1000);
            const mm = String(Math.floor(secs / 60)).padStart(2, '0');
            const ss = String(secs % 60).padStart(2, '0');
            const el = document.getElementById('callTimer');
            if (el) el.textContent = mm + ':' + ss;
        }, 1000);
    },

    _stopCallTimer: function () {
        if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    },

    _cleanup: function () {
        this._stopCallTimer();
        this.currentSession = null;
        this.callStartTime = null;
        this.isMuted = false;
        this._answerAttempted = false;
        try { if (typeof AllemmRingback !== 'undefined') AllemmRingback.stop(); } catch (e) {}
    }
};

/* ---------- Eventos que llegan del motor web ---------- */

AllemmBridge.on('health', function (d) {
    AllemmAlerts.setHealth(d.state || 'warning');
});

AllemmBridge.on('registered', function () {
    AllemmSIP.isRegistered = true;
    AllemmSIP.isRetrying = false;
    AllemmSIP.retryCount = 0;
    AllemmAlerts.setHealth('ok');
    AllemmAlerts.resetRetryCounter();
    AllemmAlerts.close();
    if (AllemmSIP.onRegistered) AllemmSIP.onRegistered();
});

AllemmBridge.on('unregistered', function () {
    AllemmSIP.isRegistered = false;
    if (AllemmSIP.onUnregistered) AllemmSIP.onUnregistered();
});

AllemmBridge.on('registration_failed', function (d) {
    AllemmSIP.isRegistered = false;
    allemmError('❌ Falló el registro:', d.cause, d.code || '', d.reason || '');
    AllemmAlerts.setHealth('error');
    if (AllemmSIP.onRegistrationFailed) AllemmSIP.onRegistrationFailed(d.cause || 'Connection Error');
    if (d.hint === 'auth_ban') {
        // app.js muestra el modal genérico de "fuera de línea"; lo reemplazamos
        // por la explicación real un instante después.
        setTimeout(function () {
            AllemmAlerts.show('PBX_BLOCKED_AFTER_AUTH', {
                autoRetry: false,
                retryCallback: function () { AllemmSIP.reconnect(); }
            });
        }, 1300);
    }
});

AllemmBridge.on('incoming_call', function (d) {
    if (AllemmSIP.currentSession) {
        // El motor ya contestó 486 Busy; nunca debería llegar aquí.
        allemmWarn('Entrante ignorada: ya hay sesión');
        return;
    }
    AllemmSIP.currentSession = new AllemmSession('incoming');
    AllemmSIP.isMuted = false;
    AllemmSIP._answerAttempted = false;
    const caller = d.caller || 'desconocido';
    allemmLog('📲 Llamada entrante de:', caller, d.display || '');
    if (AllemmSIP.onIncomingCall) AllemmSIP.onIncomingCall(caller);
});

AllemmBridge.on('call_progress', function () {
    try {
        if (AllemmSIP.currentSession && AllemmSIP.currentSession.direction === 'outgoing'
            && typeof AllemmRingback !== 'undefined') {
            AllemmRingback.start();
        }
    } catch (e) { allemmWarn('No se pudo iniciar ringback:', e.message); }
    if (AllemmSIP.onCallProgress) AllemmSIP.onCallProgress();
});

AllemmBridge.on('call_answered', function () {
    try { if (typeof AllemmRingback !== 'undefined') AllemmRingback.stop(); } catch (e) {}
    if (AllemmSIP.currentSession) AllemmSIP.currentSession.established = true;
    AllemmSIP.callStartTime = Date.now();
    AllemmSIP._startCallTimer();
    if (AllemmSIP.onCallAnswered) AllemmSIP.onCallAnswered();
});

AllemmBridge.on('call_ended', function () {
    AllemmSIP._cleanup();
    if (AllemmSIP.onCallEnded) AllemmSIP.onCallEnded();
});

AllemmBridge.on('call_failed', function (d) {
    const cause = d.cause || 'Canceled';
    if (cause === 'Canceled' || cause === 'BYE') {
        allemmLog('Llamada finalizada/cancelada:', cause);
    } else {
        allemmError('❌ Llamada falló:', cause, d.code || '');
    }
    AllemmSIP._cleanup();

    if (d.taken_by_colleague) {
        AllemmAlerts.show('CALL_TAKEN', { details: { cause: cause } });
    } else if (cause !== 'Canceled' && cause !== 'BYE') {
        AllemmAlerts.show(AllemmAlerts.mapCallFailure(cause, d.code), { details: { cause: cause, code: d.code, reason: d.reason } });
    }
    if (AllemmSIP.onCallFailed) AllemmSIP.onCallFailed(cause);
});

AllemmBridge.on('transfer_status', function (d) {
    allemmLog('Transferencia:', d.code, d.reason, d.final ? '(final)' : '');
});

AllemmBridge.on('engine_error', function (d) {
    allemmError('Error del motor:', d.message);
    AllemmAlerts.show('UNKNOWN', { details: d.message || 'Error del motor SIP' });
});

/* Avisar al motor cuando vuelve la red (reconecta el WebSocket y registra). */
window.addEventListener('online', function () {
    AllemmBridge.call('sip_network_changed').catch(function () {});
});
