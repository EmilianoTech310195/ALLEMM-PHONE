/* ========================================
   ALLEMM SIP - Motor SIP de escritorio (puente)
   ========================================
   Sustituye al sip.js de la versión web (JsSIP + WebSocket + WebRTC).
   Mantiene EXACTAMENTE el mismo contrato que usaba app.js:

     UvacSIP.init(ext, pass) / reconnect() / disconnect()
     UvacSIP.makeCall(n) / answer() / hangup() / toggleMute()
     UvacSIP.transfer(n) / sendDTMF(t)
     UvacSIP.isRegistered / currentSession / savedExtension / retryCount / ua
     UvacSIP.onRegistered / onRegistrationFailed / onUnregistered
     UvacSIP.onIncomingCall / onCallProgress / onCallAnswered
     UvacSIP.onCallEnded / onCallFailed

   Por debajo todo lo hace PJSIP (pjsua2) en Python, a través de
   window.pywebview.api. Los eventos del motor llegan por
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
            uvacLog('⇐ motor:', evt.name, evt.data || {});
            if (fn) fn(evt.data || {});
        } catch (err) {
            uvacError('Error procesando evento ' + (evt && evt.name) + ':', err);
        }
    },

    api: function () {
        return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    },

    /** Llama a un método del API nativo. Devuelve una promesa. */
    call: function (method) {
        const args = Array.prototype.slice.call(arguments, 1);
        const api = this.api();
        if (!api || typeof api[method] !== 'function') {
            return Promise.reject(new Error('API nativo no disponible: ' + method));
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

const UvacSIP = {

    // Estado (mismos nombres que la versión web)
    ua: { isConnected: function () { return UvacSIP.isRegistered; } },
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
        uvacLog('Inicializando motor nativo con extensión:', extension);
        if (!UvacAlerts.preflightCheck()) return false;

        this.savedExtension = extension;
        this.savedPassword = password;
        return this._connect();
    },

    _connect: function () {
        const self = this;
        UvacAlerts.setHealth('warning');
        // Servidor SIP capturado en el login (host o host:puerto), como en el .exe anterior.
        const serverInput = document.getElementById('sipServer');
        const server = serverInput ? serverInput.value.trim() : '';
        AllemmBridge.call('sip_register', this.savedExtension, this.savedPassword, server)
            .then(function (res) {
                if (res && res.ok === false) {
                    uvacError('Registro rechazado por el motor:', res.error);
                    UvacAlerts.setHealth('error');
                    if (self.onRegistrationFailed) self.onRegistrationFailed('Connection Error');
                }
            })
            .catch(function (err) {
                uvacError('No se pudo iniciar el registro:', err);
                UvacAlerts.setHealth('error');
                if (self.onRegistrationFailed) self.onRegistrationFailed('Connection Error');
            });
        return true;
    },

    /** Reconectar manualmente (botón "Reintentar"). */
    reconnect: function () {
        uvacLog('🔄 Reconectando...');
        UvacAlerts.setHealth('warning');
        if (!this.savedExtension) return;
        AllemmBridge.call('sip_reconnect').catch(function (err) {
            uvacError('reconnect falló:', err);
        });
    },

    /** Desconectar (cerrar sesión). */
    disconnect: function () {
        if (this.currentSession) this.hangup();
        this.isRegistered = false;
        this.savedExtension = null;
        this.savedPassword = null;
        this._cleanup();
        UvacAlerts.setHealth('offline');
        AllemmBridge.call('sip_unregister').catch(function () {});
    },

    /** Llamar. */
    makeCall: function (number) {
        const self = this;
        if (!this.isRegistered) {
            uvacError('No registrado, no se puede llamar');
            UvacAlerts.show('WS_DISCONNECTED', {
                autoRetry: true,
                retryCallback: function () { self.reconnect(); }
            });
            return false;
        }
        if (this.currentSession) {
            uvacError('Ya hay una llamada activa');
            return false;
        }
        try { if (typeof UvacRingback !== 'undefined') UvacRingback.preload(); } catch (e) {}

        this.currentSession = new AllemmSession('outgoing');
        this.isMuted = false;
        AllemmBridge.call('sip_call', number).then(function (ok) {
            if (!ok) {
                uvacError('El motor no pudo iniciar la llamada');
                self._cleanup();
                UvacAlerts.show('CALL_FAILED', { details: { cause: 'engine' } });
                if (self.onCallFailed) self.onCallFailed('Rejected');
            }
        }).catch(function (err) {
            uvacError('sip_call falló:', err);
            self._cleanup();
            if (self.onCallFailed) self.onCallFailed('Rejected');
        });
        uvacLog('📞 Llamando a:', number);
        return true;
    },

    /** Contestar llamada entrante. */
    answer: function () {
        if (!this.currentSession) return false;
        if (this._answerAttempted) {
            uvacLog('answer() ignorado: ya se está contestando');
            return false;
        }
        this._answerAttempted = true;
        AllemmBridge.call('sip_answer').catch(function (err) { uvacError('answer falló:', err); });
        return true;
    },

    /** Colgar / rechazar. */
    hangup: function () {
        if (!this.currentSession) return false;
        AllemmBridge.call('sip_hangup').catch(function (err) { uvacError('hangup falló:', err); });
        return true;
    },

    /** Silenciar / activar micrófono. Devuelve el nuevo estado (true = muted). */
    toggleMute: function () {
        if (!this.currentSession) return false;
        const self = this;
        this.isMuted = !this.isMuted;   // respuesta inmediata para la UI
        AllemmBridge.call('sip_toggle_mute').then(function (muted) {
            self.isMuted = !!muted;
        }).catch(function (err) { uvacError('mute falló:', err); });
        return this.isMuted;
    },

    /** Transferencia ciega. */
    transfer: function (number) {
        if (!this.currentSession || !this.currentSession.isEstablished()) {
            uvacError('No hay llamada activa para transferir');
            return false;
        }
        AllemmBridge.call('sip_transfer', number).then(function (ok) {
            if (!ok) UvacAlerts.show('UNKNOWN', { details: 'El motor rechazó la transferencia' });
        }).catch(function (err) {
            UvacAlerts.show('UNKNOWN', { details: 'Error al transferir: ' + err.message });
        });
        uvacLog('Transferida a:', number);
        return true;
    },

    /** Tono DTMF durante la llamada (INFO o RFC2833 según ajustes). */
    sendDTMF: function (tone) {
        if (!this.currentSession || !this.currentSession.isEstablished()) {
            uvacWarn('DTMF NO enviado (no hay llamada establecida):', tone);
            return false;
        }
        AllemmBridge.call('sip_dtmf', tone).catch(function (err) { uvacError('DTMF falló:', err); });
        uvacLog('DTMF enviado:', tone);
        return true;
    },

    /** Retener / reanudar (extra de escritorio, no existía en la web). */
    hold: function (on) {
        if (!this.currentSession || !this.currentSession.isEstablished()) return false;
        AllemmBridge.call('sip_hold', !!on).catch(function (err) { uvacError('hold falló:', err); });
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
        try { if (typeof UvacRingback !== 'undefined') UvacRingback.stop(); } catch (e) {}
    }
};

/* ---------- Eventos que llegan del motor Python ---------- */

AllemmBridge.on('health', function (d) {
    UvacAlerts.setHealth(d.state || 'warning');
});

AllemmBridge.on('registered', function () {
    UvacSIP.isRegistered = true;
    UvacSIP.isRetrying = false;
    UvacSIP.retryCount = 0;
    UvacAlerts.setHealth('ok');
    UvacAlerts.resetRetryCounter();
    UvacAlerts.close();
    if (UvacSIP.onRegistered) UvacSIP.onRegistered();
});

AllemmBridge.on('unregistered', function () {
    UvacSIP.isRegistered = false;
    if (UvacSIP.onUnregistered) UvacSIP.onUnregistered();
});

AllemmBridge.on('registration_failed', function (d) {
    UvacSIP.isRegistered = false;
    uvacError('❌ Falló el registro:', d.cause, d.code || '', d.reason || '');
    UvacAlerts.setHealth('error');
    if (UvacSIP.onRegistrationFailed) UvacSIP.onRegistrationFailed(d.cause || 'Connection Error');
    if (d.hint === 'auth_ban') {
        // app.js muestra el modal genérico de "fuera de línea"; lo reemplazamos
        // por la explicación real un instante después.
        setTimeout(function () {
            UvacAlerts.show('PBX_BLOCKED_AFTER_AUTH', {
                autoRetry: false,
                retryCallback: function () { UvacSIP.reconnect(); }
            });
        }, 1300);
    }
});

AllemmBridge.on('incoming_call', function (d) {
    if (UvacSIP.currentSession) {
        // El motor ya contestó 486 Busy; nunca debería llegar aquí.
        uvacWarn('Entrante ignorada: ya hay sesión');
        return;
    }
    UvacSIP.currentSession = new AllemmSession('incoming');
    UvacSIP.isMuted = false;
    UvacSIP._answerAttempted = false;
    const caller = d.caller || 'desconocido';
    uvacLog('📲 Llamada entrante de:', caller, d.display || '');
    if (UvacSIP.onIncomingCall) UvacSIP.onIncomingCall(caller);
});

AllemmBridge.on('call_progress', function () {
    try {
        if (UvacSIP.currentSession && UvacSIP.currentSession.direction === 'outgoing'
            && typeof UvacRingback !== 'undefined') {
            UvacRingback.start();
        }
    } catch (e) { uvacWarn('No se pudo iniciar ringback:', e.message); }
    if (UvacSIP.onCallProgress) UvacSIP.onCallProgress();
});

AllemmBridge.on('call_answered', function () {
    try { if (typeof UvacRingback !== 'undefined') UvacRingback.stop(); } catch (e) {}
    if (UvacSIP.currentSession) UvacSIP.currentSession.established = true;
    UvacSIP.callStartTime = Date.now();
    UvacSIP._startCallTimer();
    if (UvacSIP.onCallAnswered) UvacSIP.onCallAnswered();
});

AllemmBridge.on('call_ended', function () {
    UvacSIP._cleanup();
    if (UvacSIP.onCallEnded) UvacSIP.onCallEnded();
});

AllemmBridge.on('call_failed', function (d) {
    const cause = d.cause || 'Canceled';
    if (cause === 'Canceled' || cause === 'BYE') {
        uvacLog('Llamada finalizada/cancelada:', cause);
    } else {
        uvacError('❌ Llamada falló:', cause, d.code || '');
    }
    UvacSIP._cleanup();

    if (d.taken_by_colleague) {
        UvacAlerts.show('CALL_TAKEN', { details: { cause: cause } });
    } else if (cause !== 'Canceled' && cause !== 'BYE') {
        UvacAlerts.show(UvacAlerts.mapJsSipError(cause), { details: { cause: cause, code: d.code } });
    }
    if (UvacSIP.onCallFailed) UvacSIP.onCallFailed(cause);
});

AllemmBridge.on('transport_fallback', function (d) {
    uvacLog('⚠️ ' + String(d.from).toUpperCase() + ' sin respuesta; probando ' + String(d.to).toUpperCase());
    UvacAlerts.setHealth('warning');
    try { if (typeof UvacApp !== 'undefined') UvacApp._showLoginStatus('Sin respuesta por UDP, probando TCP...', 'success'); } catch (e) {}
});

AllemmBridge.on('network_blocked', function () {
    // Android: sin WiFi y "Red móvil" desactivada en Ajustes.
    setTimeout(function () {
        UvacAlerts.show('NETWORK_BLOCKED', { autoRetry: false, retryCallback: function () { UvacSIP.reconnect(); } });
    }, 1300);
});

AllemmBridge.on('transfer_status', function (d) {
    uvacLog('Transferencia:', d.code, d.reason, d.final ? '(final)' : '');
});

AllemmBridge.on('engine_error', function (d) {
    uvacError('Error del motor:', d.message);
    UvacAlerts.show('UNKNOWN', { details: d.message || 'Error del motor SIP' });
});

AllemmBridge.on('launch_number', function (d) {
    // Otra instancia (enlace tel:/callto:) nos pasó un número a marcar.
    if (typeof UvacApp === 'undefined' || !d.number) return;
    UvacApp.pendingAutoCall = String(d.number);
    UvacApp.autoCallDone = false;
    UvacApp._handleAutoCall(0);
});

/* Avisar al motor cuando cambia la red (el motor rehace transportes/registro). */
window.addEventListener('online', function () {
    AllemmBridge.call('sip_network_changed').catch(function () {});
});

/* ---------- Escritorio: sin notificaciones del navegador ----------
   En el .exe las llamadas entrantes las avisa el motor (timbre, ventana al
   frente y parpadeo en la barra de tareas). El permiso de notificaciones y el
   banner "Activa las notificaciones" eran de la versión web (PWA). */
document.addEventListener('DOMContentLoaded', function () {
    if (typeof UvacApp === 'undefined') return;
    UvacApp._requestNotificationPermission = function () {};
    UvacApp._showNotifBanner = function () {};
    UvacApp._onClickEnableNotif = function () {};
    UvacApp._showCallNotification = function () {};
    const banner = document.getElementById('notifBanner');
    if (banner) banner.classList.add('hidden');
});
