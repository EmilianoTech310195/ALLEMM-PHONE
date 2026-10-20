/* ========================================
   uvacSIP Web - Lógica de UI
   ========================================
   Maneja: dialpad, login, historial, atajos
           de teclado, modal de transferencia.
   ======================================== */

const UvacApp = {

    // Estado
    callHistory: [],
    isInCall: false,
    currentCallNumber: '',
    isMobile: false,
    speakerActive: false,
    wakeLock: null,

    // === Click-to-call (?call=NUMERO) ===
    // Si AUTO_DIAL = true  → marca automáticamente al cargar el link (ideal CRM)
    // Si AUTO_DIAL = false → solo pone el número en el marcador y tú das "Llamar"
    AUTO_DIAL: true,
    pendingAutoCall: null,   // número leído de la URL, pendiente de marcar
    autoCallDone: false,     // evita re-marcar si el SIP se re-registra

    // === Sesión persistente ===
    // La contraseña SIP se guarda en sessionStorage (vive solo mientras la
    // ventana del navegador esté abierta). Si el empleado cierra el navegador,
    // se vuelve a pedir login. Mientras la ventana siga abierta y dentro de
    // este margen de horas, los links ?call= entran directo.
    SESSION_HOURS: 8,

    // === Referrer confiable para auto-dial ===
    // Si el link ?call= viene de estos dominios (o subdominios), marcamos
    // solo. Si viene de cualquier otro lado (WhatsApp, email, link copiado),
    // pedimos confirmación al usuario antes de marcar.
    TRUSTED_REFERRERS: ['uvaconline.com.mx'],

    /**
     * Inicializar la app
     */
    init: function() {
        uvacLog('Inicializando UI...');

        // Detectar si es móvil/tablet
        this.isMobile = this._detectMobile();
        if (this.isMobile) {
            uvacLog('📱 Dispositivo móvil/tablet detectado');
            document.body.classList.add('is-mobile');
        }

        this._loadStoredCredentials();
        this._setupLoginHandlers();
        this._setupDialpadHandlers();
        this._setupCallHandlers();
        this._setupKeyboardShortcuts();
        this._setupTransferModal();
        this._loadHistory();
        this._setupSipCallbacks();
        this._setupMobileFeatures();
        this._readCallParam();
    },

    /**
     * Leer el parámetro ?call=NUMERO de la URL (click-to-call desde CRM/cotizador).
     * No marca todavía: solo guarda el número. El marcado real ocurre en
     * onRegistered (cuando la línea SIP ya está lista), vía _handleAutoCall().
     * Ejemplo de uso: https://uvaconline.com.mx/telefonia/?call=2295125192
     */
    _readCallParam: function() {
        try {
            const params = new URLSearchParams(window.location.search);
            const raw = params.get('call');
            if (!raw) return;

            // Sanitizar: solo dígitos, * y # (igual criterio que _makeCall).
            // Esto evita marcar basura si el CRM manda algo con formato.
            const cleaned = raw.replace(/[^\d*#]/g, '');
            if (!cleaned) {
                uvacWarn('Parámetro ?call= sin dígitos válidos: "' + raw + '"');
                return;
            }

            this.pendingAutoCall = cleaned;
            uvacLog('🔗 Click-to-call detectado en URL: "' + raw + '" → "' + cleaned + '"');

            // Limpiar el parámetro de la barra de direcciones para que un
            // refresh (F5) NO vuelva a disparar la llamada accidentalmente.
            try {
                const cleanUrl = window.location.origin + window.location.pathname + window.location.hash;
                window.history.replaceState({}, document.title, cleanUrl);
            } catch (e) {
                // replaceState puede fallar en contextos raros; no es crítico
            }

            // Intentar el auto-marcado también desde aquí. Si el SIP todavía no
            // está registrado, _handleAutoCall reintentará solo. Esto cubre el
            // caso en que el registro ocurra ANTES de que onRegistered enganche
            // el marcado (timing de PBX rápido). Si onRegistered ya lo disparó,
            // la bandera autoCallDone evita marcar dos veces.
            const self = this;
            setTimeout(() => self._handleAutoCall(0), 500);
        } catch (err) {
            uvacWarn('No se pudo leer el parámetro ?call=:', err.message);
        }
    },

    /**
     * Ejecutar el auto-marcado pendiente (si lo hay).
     * Se invoca desde onRegistered y también desde _readCallParam (cubre ambos
     * órdenes posibles: que el registro ocurra antes o después de leer la URL).
     * Reintenta si la línea SIP aún no está lista, y solo marca autoCallDone
     * cuando la llamada se inició de verdad.
     */
    _handleAutoCall: function(intento) {
        intento = intento || 0;

        // Nada pendiente, o ya se marcó antes en esta sesión
        if (!this.pendingAutoCall || this.autoCallDone) return;

        // Si ya hay una llamada activa, no interrumpir: descartar el auto-marcado
        if (this.isInCall) {
            uvacLog('🔗 Auto-marcado ignorado: ya hay una llamada activa');
            this.pendingAutoCall = null;
            return;
        }

        const self = this;

        // Si la línea aún no está registrada, reintentar hasta ~10 segundos
        // (20 intentos x 500ms). Esto cubre el caso de timing: el parámetro se
        // leyó pero el SIP todavía no termina de registrarse.
        if (!UvacSIP.isRegistered) {
            if (intento < 20) {
                uvacLog('🔗 Auto-marcado en espera (SIP no registrado), reintento ' + (intento + 1));
                setTimeout(() => self._handleAutoCall(intento + 1), 500);
            } else {
                uvacLog('🔗 Auto-marcado cancelado: SIP no se registró a tiempo');
            }
            return;
        }

        // Verificar que la pantalla de la app esté visible (no la de login).
        // Si seguimos en login, esperar un poco más.
        const appScreen = document.getElementById('appScreen');
        if (appScreen && appScreen.classList.contains('hidden')) {
            if (intento < 20) {
                uvacLog('🔗 Auto-marcado en espera (app no visible aún), reintento ' + (intento + 1));
                setTimeout(() => self._handleAutoCall(intento + 1), 500);
            }
            return;
        }

        const number = this.pendingAutoCall;

        // Colocar el número en el marcador (refleja CallerID/bandera en vivo)
        const display = document.getElementById('numberDisplay');
        if (display) {
            display.value = number;
            this._updateLiveCallerID();
        }

        // Asegurar que estamos en la vista del marcador
        this._showDialerView();

        if (this.AUTO_DIAL) {
            // Si el link no viene de un dominio de confianza, pedir confirmación
            // antes de marcar. Esto bloquea fraude vía links de WhatsApp/email
            // que apunten a ?call=NUMERO-PREMIUM.
            if (!this._isTrustedReferrer()) {
                const ref = document.referrer || '(link directo)';
                uvacLog('🔗 Referrer no confiable (' + ref + '), pidiendo confirmación');
                const proceed = confirm('¿Llamar al número ' + number + ' ?');
                if (!proceed) {
                    uvacLog('🔗 Auto-marcado cancelado por el usuario');
                    self.pendingAutoCall = null;
                    self.autoCallDone = true;
                    return;
                }
            }

            // Delay para que la UI termine de pintar y el SIP se asiente antes de marcar
            setTimeout(() => {
                // Re-verificar justo antes de marcar (por si algo cambió)
                if (self.autoCallDone || self.isInCall) return;
                if (!UvacSIP.isRegistered) {
                    uvacLog('🔗 SIP se desregistró antes de marcar, reintentando...');
                    self._handleAutoCall(0);
                    return;
                }
                uvacLog('🔗 Marcando automáticamente: ' + number);
                // Marcar la bandera SOLO aquí, justo cuando vamos a llamar de verdad
                self.autoCallDone = true;
                self.pendingAutoCall = null;
                self._makeCall();
            }, 1200);
        } else {
            this.autoCallDone = true;
            this.pendingAutoCall = null;
            uvacLog('🔗 Número precargado en el marcador (AUTO_DIAL desactivado)');
        }
    },

    /**
     * Detectar dispositivo móvil/tablet
     */
    _detectMobile: function() {
        const ua = navigator.userAgent;
        const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        const isSmallScreen = window.innerWidth <= 1024;
        return isMobileUA || (isTouchDevice && isSmallScreen);
    },

    /**
     * Configurar features específicas de móvil
     */
    _setupMobileFeatures: function() {
        const self = this;

        // Detectar cuando el usuario sale del navegador / regresa
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (self.isInCall) uvacLog('⚠️ Usuario salió del navegador con llamada activa');
            } else {
                // Al VOLVER al frente (muy común en celular tras bloquear la
                // pantalla o cambiar de app): el navegador móvil suele haber
                // suspendido la conexión con el PBX, por lo que dejan de entrar
                // llamadas.
                if (self.isInCall) self._requestWakeLock();

                if (typeof UvacSIP === 'undefined') return;

                // NO reconectar si hay una llamada/sesión en curso: reconnect()
                // hace stop() y mataría la sesión (p.ej. una entrante que llega
                // justo al volver al frente).
                if (UvacSIP.currentSession) {
                    uvacLog('↩️ Regreso al frente con llamada en curso: no se toca la conexión');
                    return;
                }

                // Detectar la conexión REAL con el PBX, no solo la bandera
                // isRegistered (que puede quedar "fantasma" en true si el
                // navegador suspendió la página sin avisar).
                let socketAlive = true;
                try {
                    if (UvacSIP.ua && typeof UvacSIP.ua.isConnected === 'function') {
                        socketAlive = UvacSIP.ua.isConnected();
                    }
                } catch (e) { socketAlive = false; }

                if (UvacSIP.savedExtension && (!UvacSIP.isRegistered || !socketAlive)) {
                    uvacLog('🔄 Regreso al frente: conexión con el PBX caída, reconectando…');
                    UvacSIP.reconnect();
                } else {
                    uvacLog('✅ Usuario regresó al navegador (conexión OK)');
                }
            }
        });

        // Avisar antes de cerrar/recargar si hay llamada activa
        window.addEventListener('beforeunload', (e) => {
            if (self.isInCall) {
                e.preventDefault();
                e.returnValue = 'Tienes una llamada activa. ¿Salir?';
                return e.returnValue;
            }
        });

        // Detectar cambios de red (sip.js avisa al motor; aquí solo reconectamos si hace falta)
        window.addEventListener('online', () => {
            uvacLog('🟢 Internet recuperado');
            if (!UvacSIP.isRegistered && UvacSIP.savedExtension) {
                setTimeout(() => { if (!UvacSIP.isRegistered) UvacSIP.reconnect(); }, 3000);
            }
        });
    },

    /**
     * Cargar credenciales guardadas y hacer login automático si la sesión
     * de 24h sigue vigente.
     *
     * Lógica:
     *  - Si hay credenciales Y la sesión NO ha expirado (< SESSION_HOURS) →
     *    login automático directo, sin importar la casilla "Recordar".
     *  - Si la sesión expiró → se borran las credenciales y se pide login.
     *  - "Recordar" sigue funcionando para pre-llenar la extensión.
     */
    _loadStoredCredentials: function() {
        // Migración: borrar contraseñas viejas que quedaron en localStorage
        // (versiones anteriores las guardaban ahí, ya no las queremos)
        if (localStorage.getItem('uvac_password') || localStorage.getItem('uvac_login_time')) {
            localStorage.removeItem('uvac_password');
            localStorage.removeItem('uvac_login_time');
            uvacLog('🔄 Limpieza: contraseña antigua eliminada de localStorage');
        }

        const ext = localStorage.getItem('uvac_extension');
        const remember = localStorage.getItem('uvac_remember') === 'true';

        // La contraseña ahora vive solo en sessionStorage (muere al cerrar
        // el navegador). El campo y la marca de tiempo también van ahí.
        const pass = sessionStorage.getItem('uvac_password');
        const loginTime = parseInt(sessionStorage.getItem('uvac_login_time') || '0', 10);

        const maxAgeMs = this.SESSION_HOURS * 60 * 60 * 1000;
        const sessionValid = loginTime > 0 && (Date.now() - loginTime) < maxAgeMs;

        if (loginTime > 0 && !sessionValid) {
            uvacLog('⏰ Sesión de ' + this.SESSION_HOURS + 'h expirada. Se requiere login.');
            sessionStorage.removeItem('uvac_password');
            sessionStorage.removeItem('uvac_login_time');
        }

        // Pre-llenar extensión si la recordamos (aunque la sesión haya expirado)
        if (ext && remember) {
            document.getElementById('extension').value = ext;
            document.getElementById('rememberMe').checked = true;
        }

        // Login automático SOLO si tenemos contraseña en sesión y es válida
        if (ext && pass && sessionValid) {
            try {
                const decodedPass = atob(pass);
                document.getElementById('extension').value = ext;
                // NO escribimos la contraseña en el <input>: va directo al
                // motor SIP. Así no queda expuesta en el DOM ni se revela
                // con el botón "ojo" del campo.

                const horasRestantes = Math.round((maxAgeMs - (Date.now() - loginTime)) / (60 * 60 * 1000));
                uvacLog('🔐 Sesión válida (~' + horasRestantes + 'h restantes). Login automático.');

                const self = this;
                setTimeout(() => {
                    self._showLoginStatus('🔐 Reconectando...', 'success');
                    self._setLoginLoading(true);
                    UvacAlerts.setHealth('warning');
                    UvacSIP.init(ext, decodedPass);
                    document.getElementById('extensionLabel').textContent = 'Ext. ' + ext;
                }, 300);
            } catch (err) {
                uvacWarn('No se pudo cargar contraseña guardada:', err.message);
                sessionStorage.removeItem('uvac_password');
                sessionStorage.removeItem('uvac_login_time');
            }
        }
    },

    /**
     * Devuelve true si el link ?call= que cargó la app viene de un dominio
     * de confianza (CRM oficial). Si no, el auto-marcado pedirá confirmación.
     */
    _isTrustedReferrer: function() {
        try {
            const ref = document.referrer;
            if (!ref) return false;  // Sin referrer (link pegado en barra) = desconocido
            const host = new URL(ref).hostname.toLowerCase();
            return this.TRUSTED_REFERRERS.some(d => {
                d = d.toLowerCase();
                return host === d || host.endsWith('.' + d);
            });
        } catch (e) {
            return false;
        }
    },

    /**
     * Cambiar entre modo "en línea" y "fuera de línea"
     */
    _setOnlineMode: function(online) {
        const callBtn = document.getElementById('callBtn');
        const transferBtn = document.getElementById('transferBtn');

        if (online) {
            callBtn.disabled = false;
            callBtn.innerHTML = '<i class="ti ti-phone"></i>';
            callBtn.classList.remove('btn-call-disabled');
            callBtn.title = 'Llamar';
            if (transferBtn) transferBtn.disabled = false;
        } else {
            callBtn.disabled = true;
            callBtn.innerHTML = '<i class="ti ti-phone-off"></i>';
            callBtn.classList.add('btn-call-disabled');
            callBtn.title = 'Sin conexión';
            if (transferBtn) transferBtn.disabled = true;
        }
    },

    /**
     * Mostrar/ocultar spinner en botón de login
     */
    _setLoginLoading: function(loading) {
        const btn = document.getElementById('loginBtn');
        if (loading) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Conectando...';
        } else {
            btn.disabled = false;
            btn.innerHTML = 'Conectar';
        }
    },

    /**
     * Mostrar modal de "Fuera de línea" con botón de reconectar
     */
    _showOfflineAlert: function() {
        const self = this;
        UvacAlerts.show('WS_DISCONNECTED', {
            details: 'El softphone está fuera de línea. Para hacer llamadas, presiona "Reintentar ahora".',
            autoRetry: false,
            retryCallback: () => {
                self._updateStatus('Reconectando...', 'warning');
                UvacSIP.retryCount = 0; // Reset el contador
                UvacSIP.reconnect();
            }
        });
    },

    /**
     * Reproducir el timbre de llamada entrante de forma robusta.
     * En celular el navegador puede rechazar el primer play(); reintentamos una
     * vez y avisamos en el log si sigue bloqueado (para diagnosticar en iPhone).
     * El desbloqueo del login (_unlockMediaOnGesture) es lo que permite que suene.
     */
    _playRingtone: function() {
        try {
            const r = document.getElementById('ringtone');
            if (!r) return;
            r.muted = false;
            r.volume = 1.0;
            try { r.currentTime = 0; } catch (e) {}
            const p = r.play();
            if (p && typeof p.catch === 'function') {
                p.catch(err => {
                    uvacWarn('Timbre bloqueado por el navegador:', err && err.name);
                    // Reintento breve: a veces el primer play se rechaza y el segundo pasa.
                    setTimeout(() => { try { r.play().catch(() => {}); } catch (e) {} }, 300);
                });
            }
        } catch (e) {}
    },

    /**
     * Desbloquear audio y micrófono aprovechando un gesto del usuario (login).
     * iOS/celular exigen una interacción para poder reproducir sonido y usar el
     * micrófono; al hacerlo aquí, después el timbre suena y el auto-marcado toma
     * micrófono sin pedir un toque extra. En computadora es inofensivo.
     */
    _unlockMediaOnGesture: function() {
        // 1) AudioContext del ringback (tono de espera)
        try {
            if (typeof UvacRingback !== 'undefined') UvacRingback.preload();
        } catch (e) {}

        // 2) Desbloquear SOLO el timbre (ringtone): reproducir en mute y pausar
        //    dentro de este gesto, para que luego pueda sonar aunque la llamada
        //    entrante no venga de un toque (requisito iOS).
        //    NOTA: NO se toca remoteAudio aquí. La voz remota se reproduce en
        //    _attachRemoteStream (tras contestar/llamar, que ya es un gesto) y
        //    ahí se fuerza sin mute. Silenciarlo aquí causaba audio en un solo
        //    sentido (el agente no escuchaba al otro lado).
        try {
            ['ringtone'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.muted = true;
                const p = el.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
                     .catch(() => { el.muted = false; });
                } else {
                    try { el.pause(); } catch (e) {}
                    el.muted = false;
                }
            });
        } catch (e) {}

        // 3) Pre-autorizar el micrófono (una vez). Con el permiso ya concedido,
        //    el auto-marcado en iPhone funciona sin un toque adicional.
        try {
            // En escritorio el micrófono lo abre PJSIP (no WebRTC): no pedir permiso al WebView.
            const nativeEngine = !!(window.pywebview && window.pywebview.api);
            if (!nativeEngine && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && !this._micUnlocked) {
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => {
                        this._micUnlocked = true;
                        stream.getTracks().forEach(t => t.stop());
                        uvacLog('🎤 Micrófono pre-autorizado');
                    })
                    .catch(err => {
                        // No bloquea el login, pero avisa CLARO qué pasa (en vez
                        // de un "Error desconocido" después, al intentar llamar).
                        const name = err && err.name;
                        uvacWarn('No se pudo pre-autorizar micrófono:', name);
                        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                            UvacAlerts.show('MIC_DENIED');
                        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                            UvacAlerts.show('MIC_NOT_FOUND');
                        }
                    });
            }
        } catch (e) {}
    },

    // ===================================================================
    //  MODO VENTANA FLOTANTE (Document Picture-in-Picture) — SOLO ESCRITORIO
    //  Saca los controles de la llamada a una ventanita que el colaborador
    //  puede mover por toda la pantalla, encima de otras apps, sin cortar la
    //  llamada. Solo Chrome/Edge de computadora; en otros casos ni aparece.
    // ===================================================================

    /** ¿El navegador soporta ventana flotante y NO es celular? */
    _floatingSupported: function() {
        return !this.isMobile && ('documentPictureInPicture' in window);
    },

    /** Mostrar el botón flotante solo en escritorio compatible y con llamada activa. */
    _updateFloatBtnVisibility: function() {
        const btn = document.getElementById('floatBtn');
        if (!btn) return;
        if (this._floatingSupported() && this.isInCall) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }
    },

    /** Abrir la ventana flotante con los controles de la llamada. */
    _openFloatingWidget: function() {
        const self = this;
        if (!this._floatingSupported()) return;
        try {
            // Si ya hay una abierta, solo enfocarla
            if (window.documentPictureInPicture.window) {
                window.documentPictureInPicture.window.focus();
                return;
            }
            window.documentPictureInPicture
                .requestWindow({ width: 250, height: 390 })
                .then(pip => {
                    self._pipWindow = pip;
                    self._renderFloatingWidget(pip);
                    pip.addEventListener('pagehide', () => {
                        if (self._pipSyncTimer) { clearInterval(self._pipSyncTimer); self._pipSyncTimer = null; }
                        self._pipWindow = null;
                    });
                })
                .catch(err => uvacError('No se pudo abrir la ventana flotante:', err && err.message));
        } catch (err) {
            uvacError('Error en modo flotante:', err && err.message);
        }
    },

    /** Cerrar la ventana flotante (al colgar o terminar la llamada). */
    _closeFloatingWidget: function() {
        try {
            if (this._pipSyncTimer) { clearInterval(this._pipSyncTimer); this._pipSyncTimer = null; }
            if (this._pipWindow) { this._pipWindow.close(); this._pipWindow = null; }
        } catch (e) {}
    },

    /** Construir el contenido de la ventana flotante y conectar sus botones. */
    _renderFloatingWidget: function(pip) {
        const self = this;
        // La ventana PiP NO hereda el CSS de la página: inyectamos estilos propios.
        const style = pip.document.createElement('style');
        style.textContent = [
            '*{box-sizing:border-box;font-family:system-ui,-apple-system,Arial,sans-serif}',
            'body{margin:0;background:#0f2547;color:#fff;user-select:none}',
            '.wrap{padding:12px;display:flex;flex-direction:column;height:100vh}',
            '.num{font-size:18px;font-weight:700;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.st{font-size:12px;text-align:center;opacity:.8;margin-top:2px}',
            '.tm{font-size:26px;font-weight:700;text-align:center;margin:8px 0;letter-spacing:1px}',
            '.kp{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:4px 0}',
            '.kp button{padding:8px 0;font-size:16px;border:0;border-radius:8px;background:#1c3b66;color:#fff;cursor:pointer}',
            '.kp button:active{background:#2a5490}',
            '.row{display:flex;gap:8px;margin-top:auto}',
            '.row button{flex:1;padding:12px 0;font-size:13px;border:0;border-radius:10px;cursor:pointer;font-weight:700}',
            '.mute{background:#2a5490;color:#fff}.mute.on{background:#d97706}',
            '.hang{background:#dc2626;color:#fff}'
        ].join('');
        pip.document.head.appendChild(style);

        const keys = ['1','2','3','4','5','6','7','8','9','*','0','#'];
        pip.document.body.innerHTML =
            '<div class="wrap">' +
                '<div class="num" id="pNum">--</div>' +
                '<div class="st" id="pSt"></div>' +
                '<div class="tm" id="pTm">00:00</div>' +
                '<div class="kp" id="pKp">' +
                    keys.map(function(d){ return '<button data-k="'+d+'">'+d+'</button>'; }).join('') +
                '</div>' +
                '<div class="row">' +
                    '<button class="mute" id="pMute">🎤 Silenciar</button>' +
                    '<button class="hang" id="pHang">📵 Colgar</button>' +
                '</div>' +
            '</div>';

        const doc = pip.document;
        // Teclado → DTMF
        doc.getElementById('pKp').querySelectorAll('button').forEach(function(b){
            b.addEventListener('click', function(){ UvacSIP.sendDTMF(b.getAttribute('data-k')); });
        });
        // Silenciar (refleja también en el botón principal)
        const pMute = doc.getElementById('pMute');
        pMute.addEventListener('click', function(){
            const muted = UvacSIP.toggleMute();
            pMute.classList.toggle('on', muted);
            pMute.textContent = muted ? '🔇 Activar' : '🎤 Silenciar';
            const mainMute = document.getElementById('muteBtn');
            if (mainMute) {
                mainMute.classList.toggle('active', muted);
                mainMute.innerHTML = muted ? '<i class="ti ti-microphone-off"></i>' : '<i class="ti ti-microphone"></i>';
            }
        });
        // Colgar
        doc.getElementById('pHang').addEventListener('click', function(){ UvacSIP.hangup(); });

        // Reflejar número/estado/tiempo desde la página principal cada segundo.
        const sync = function(){
            try {
                if (!self.isInCall || !UvacSIP.currentSession) { self._closeFloatingWidget(); return; }
                const n = document.getElementById('callNumber');
                const s = document.getElementById('callStatus');
                const t = document.getElementById('callTimer');
                if (n) doc.getElementById('pNum').textContent = n.textContent;
                if (s) doc.getElementById('pSt').textContent = s.textContent;
                if (t) doc.getElementById('pTm').textContent = t.textContent;
            } catch (e) {}
        };
        sync();
        self._pipSyncTimer = setInterval(sync, 1000);
    },

    /**
     * Configurar pantalla de login
     */
    _setupLoginHandlers: function() {
        const self = this;

        document.getElementById('loginBtn').addEventListener('click', () => {
            // Aprovechar ESTE toque del usuario para desbloquear audio y micrófono
            // (requisito de iOS/celular para que suene el timbre y el auto-marcado
            //  tome micrófono sin un toque extra).
            self._unlockMediaOnGesture();
            self._doLogin();
        });

        document.getElementById('password').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                self._unlockMediaOnGesture();
                self._doLogin();
            }
        });

        document.getElementById('extension').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('password').focus();
            }
        });

        document.getElementById('logoutBtn').addEventListener('click', () => {
            if (confirm('¿Cerrar sesión y desconectar?')) {
                self._doLogout();
            }
        });

        // Botón "Activar notificaciones" del banner
        const notifEnableBtn = document.getElementById('notifEnableBtn');
        if (notifEnableBtn) {
            notifEnableBtn.addEventListener('click', () => {
                self._onClickEnableNotif();
            });
        }

        // Tabs del sidebar (Marcador / Historial)
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                if (tab === 'dialer') {
                    self._showDialerView();
                } else if (tab === 'history') {
                    self._showHistoryView();
                }
            });
        });

        // Botón borrar historial
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', () => {
                if (self.callHistory.length === 0) return;
                if (confirm('¿Borrar todo el historial de llamadas?')) {
                    self.callHistory = [];
                    localStorage.removeItem('uvac_history');
                    self._renderHistory();
                }
            });
        }

        // Botón mostrar/ocultar contraseña
        document.getElementById('togglePassword').addEventListener('click', () => {
            const input = document.getElementById('password');
            const btn = document.getElementById('togglePassword');

            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = '🙈';
                btn.classList.add('showing');
                btn.title = 'Ocultar contraseña';
            } else {
                input.type = 'password';
                btn.textContent = '👁️';
                btn.classList.remove('showing');
                btn.title = 'Mostrar contraseña';
            }
        });
    },

    /**
     * Ejecutar login
     */
    _doLogin: function() {
        const ext = document.getElementById('extension').value.trim();
        const pass = document.getElementById('password').value;
        const remember = document.getElementById('rememberMe').checked;

        if (!ext || !pass) {
            this._showLoginStatus('Ingresa extensión y contraseña', 'error');
            return;
        }
        const serverInput = document.getElementById('sipServer');
        if (serverInput && !serverInput.value.trim()) {
            this._showLoginStatus('Ingresa el servidor SIP (ej. pbx.midominio.com:5060)', 'error');
            serverInput.focus();
            return;
        }

        // Extensión en localStorage (no es secreto) para pre-llenar próximos logins
        localStorage.setItem('uvac_extension', ext);

        // Contraseña SOLO en sessionStorage: muere al cerrar el navegador.
        // El base64 sigue siendo encoding, no cifrado — el objetivo es que
        // ningún login automático sobreviva al cierre de la ventana.
        sessionStorage.setItem('uvac_password', btoa(pass));
        sessionStorage.setItem('uvac_login_time', Date.now().toString());

        if (remember) {
            localStorage.setItem('uvac_remember', 'true');
        } else {
            localStorage.removeItem('uvac_remember');
        }

        // Limpiar el campo del DOM en cuanto mandamos la contraseña al motor.
        // Evita que el botón "ojo" la revele tras un login exitoso.
        document.getElementById('password').value = '';

        this._showLoginStatus('Conectando al PBX...', 'success');
        UvacAlerts.setHealth('warning');
        this._setLoginLoading(true);

        // Iniciar SIP
        UvacSIP.init(ext, pass);

        document.getElementById('extensionLabel').textContent = `Ext. ${ext}`;
    },

    _doLogout: function() {
        UvacSIP.disconnect();
        UvacAlerts.close();
        document.getElementById('appScreen').classList.add('hidden');
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('password').value = '';
        this._showLoginStatus('', '');
        this._setLoginLoading(false);

        // Al hacer logout manual, borrar credenciales y sesión guardadas
        // para que no haga login automático la próxima vez
        localStorage.removeItem('uvac_extension');
        localStorage.removeItem('uvac_remember');
        sessionStorage.removeItem('uvac_password');
        sessionStorage.removeItem('uvac_login_time');
        document.getElementById('extension').value = '';
        document.getElementById('rememberMe').checked = false;
    },

    _showLoginStatus: function(msg, type) {
        const el = document.getElementById('loginStatus');
        el.textContent = msg;
        el.className = type ? `login-status ${type}` : 'login-status';
    },

    /**
     * Configurar callbacks de SIP
     */
    _setupSipCallbacks: function() {
        const self = this;

        UvacSIP.onRegistered = () => {
            self._showLoginStatus('✅ Conectado', 'success');

            // Reportero de monitoreo (Fase 2) — avisa al panel admin. Aislado.
            if (typeof UvacReporter !== 'undefined') UvacReporter.init(UvacSIP.savedExtension);

            setTimeout(() => {
                document.getElementById('loginScreen').classList.add('hidden');
                document.getElementById('appScreen').classList.remove('hidden');
                self._updateStatus('En línea', 'success');
                self._setOnlineMode(true);

                // Solicitar permiso de notificaciones (solo una vez)
                self._requestNotificationPermission();

                // Si venimos de un link ?call=NUMERO, marcar ahora que la
                // línea ya está registrada y la app es visible.
                self._handleAutoCall();
            }, 800);
        };

        UvacSIP.onRegistrationFailed = (cause) => {
            // Si es error de credenciales → quedarse en login con alerta
            const isAuthError = (cause === 'Authentication Error' || cause === 'Forbidden');

            if (isAuthError) {
                self._showLoginStatus('❌ Contraseña inválida, intenta de nuevo', 'error');
                // Cerrar cualquier modal de error que haya salido
                UvacAlerts.close();
                // Resetear botón conectar
                self._setLoginLoading(false);
                // NO entrar a la app
                return;
            }

            // Si es error de conexión/red → entrar a la app pero en modo "fuera de línea"
            self._showLoginStatus('⚠️ Sin conexión al PBX, entrando en modo offline', 'error');
            UvacAlerts.close();
            if (typeof UvacReporter !== 'undefined') { UvacReporter.init(UvacSIP.savedExtension); UvacReporter.report('desconectado'); }

            setTimeout(() => {
                document.getElementById('loginScreen').classList.add('hidden');
                document.getElementById('appScreen').classList.remove('hidden');
                self._updateStatus('Fuera de línea', 'error');
                self._setOnlineMode(false);
                // Mostrar modal con botón de reconectar
                self._showOfflineAlert();
            }, 1000);
        };

        UvacSIP.onUnregistered = () => {
            // Solo si ya estábamos dentro de la app
            const inApp = !document.getElementById('appScreen').classList.contains('hidden');
            if (inApp) {
                self._updateStatus('Fuera de línea', 'error');
                self._setOnlineMode(false);
                self._showOfflineAlert();
            }
            if (typeof UvacReporter !== 'undefined') UvacReporter.report('desconectado');
        };

        UvacSIP.onIncomingCall = (caller) => {
            self._showIncomingCall(caller);
            if (typeof UvacReporter !== 'undefined') UvacReporter.callStarted('entrante', caller);
        };

        UvacSIP.onCallProgress = () => {
            document.getElementById('callStatus').textContent = 'Llamando...';

            // NOTA: el ringback viejo (HTML <audio>) fue reemplazado por
            // UvacRingback (AudioContext), que se dispara desde sip.js en
            // session.on('progress'). Este código se mantiene comentado por
            // si se necesita revertir.
            /*
            try {
                const ringback = document.getElementById('ringback');
                if (ringback && !self.isInCall_isIncoming) {
                    ringback.currentTime = 0;
                    ringback.volume = 1.0;
                    ringback.muted = false;
                    if (self.isMobile && ringback.setSinkId) {
                        try {
                            ringback.setSinkId('default').catch(() => {});
                        } catch (e) {}
                    }
                    ringback.play().then(() => {
                        uvacLog('🎵 Ringback reproduciendo');
                    }).catch((err) => {
                        uvacWarn('Ringback no se pudo reproducir:', err.message);
                    });
                }
            } catch (e) {
                uvacWarn('Error con ringback:', e.message);
            }
            */
        };

        UvacSIP.onCallAnswered = () => {
            document.getElementById('callStatus').textContent = 'En llamada';
            document.getElementById('answerBtn').classList.add('hidden');
            self._updateStatus('En llamada', 'success');
            // Detener ringtone si estaba sonando
            const ringtone = document.getElementById('ringtone');
            ringtone.pause();
            ringtone.currentTime = 0;
            // El ringback nuevo (UvacRingback) ya se detiene en sip.js automáticamente
            // Cerrar notificación de llamada entrante si existe
            self._closeCallNotification();
        };

        UvacSIP.onCallEnded = () => {
            self._addToHistory(self.currentCallNumber, self.isInCall ? 'completed' : 'missed');
            self._endActiveCall();
            if (typeof UvacReporter !== 'undefined') UvacReporter.callEnded();
        };

        UvacSIP.onCallFailed = (cause) => {
            self._addToHistory(self.currentCallNumber, 'missed');
            self._endActiveCall();
            self._updateStatus(`Falló: ${cause}`, 'error');
            setTimeout(() => self._updateStatus('Conectado', 'success'), 3000);
            if (typeof UvacReporter !== 'undefined') UvacReporter.callEnded();
        };
    },

    /**
     * Configurar dialpad
     */
    _setupDialpadHandlers: function() {
        const display = document.getElementById('numberDisplay');
        const self = this;

        document.querySelectorAll('.dial-key:not(.transfer-key)').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;

                // Vibración háptica corta
                if (self.isMobile && navigator.vibrate) navigator.vibrate(15);

                const established = !!(UvacSIP.currentSession && UvacSIP.currentSession.isEstablished());
                uvacLog('⌨️ Tecla pulsada:', key, '| ¿llamada establecida?:', established);

                if (established) {
                    // En llamada activa → enviar como tono DTMF (menús/IVR)
                    UvacSIP.sendDTMF(key);
                } else {
                    // Sin llamada → escribir en el casillero del número
                    display.value += key;
                    self._updateLiveCallerID();
                }
            });
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            if (self.isMobile && navigator.vibrate) navigator.vibrate(20);
            display.value = display.value.slice(0, -1);
            self._updateLiveCallerID();
        });

        // Bloquear Enter explícitamente en el input numberDisplay
        // (Enter NO debe llamar ni contestar - solo los botones lo hacen)
        display.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
            // Backspace y Delete (Supr) borran normalmente - dejar pasar
        });

        // CallerID en vivo: cuando el input cambia (teclado físico, paste, etc)
        display.addEventListener('input', () => {
            self._updateLiveCallerID();
        });
    },

    /**
     * Actualiza el indicador de país/bandera en el callbar en tiempo real,
     * mientras el usuario está tecleando un número.
     * Solo se ejecuta si NO hay llamada activa (durante una llamada el callbar
     * muestra la info de la llamada, no del input).
     */
    _updateLiveCallerID: function() {
        // No interferir si hay una llamada en curso
        if (this.isInCall) return;
        if (typeof UvacCallerID === 'undefined') return;

        const display = document.getElementById('numberDisplay');
        const callNumberEl = document.getElementById('callNumber');
        const callStatusEl = document.getElementById('callStatus');
        const avatarEl = document.getElementById('avatar');

        if (!display || !callNumberEl || !callStatusEl || !avatarEl) return;

        const raw = display.value.trim();

        // Si el campo está vacío, restaurar el estado "Sin llamada activa"
        if (!raw) {
            callNumberEl.textContent = 'Sin llamada activa';
            callStatusEl.textContent = 'Marca un número para iniciar';
            avatarEl.innerHTML = '';
            avatarEl.textContent = '--';
            return;
        }

        // Identificar y pintar
        const info = UvacCallerID.identify(raw);
        callNumberEl.textContent = info.formatted || raw;
        callStatusEl.textContent = info.country || '';
        avatarEl.textContent = '';
        avatarEl.innerHTML = info.flagSvg;
        // Asegurar tamaño del SVG dentro del avatar
        const svg = avatarEl.querySelector('svg');
        if (svg) {
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
        }
    },

    /**
     * Configurar botones de llamada
     */
    _setupCallHandlers: function() {
        const self = this;

        document.getElementById('callBtn').addEventListener('click', () => {
            self._makeCall();
        });

        document.getElementById('answerBtn').addEventListener('click', () => {
            // NO ocultar el botón aquí: en celular la conexión puede no
            // completarse al primer toque (permiso de micrófono, etc.) y si el
            // botón desaparece, el usuario se queda sin poder reintentar.
            // El doble-toque ya lo bloquea el seguro _answerAttempted en sip.js.
            // El botón se oculta solo al conectar (onCallAnswered) o al fallar.
            UvacSIP.answer();
        });

        document.getElementById('hangupBtn').addEventListener('click', () => {
            UvacSIP.hangup();
        });

        document.getElementById('muteBtn').addEventListener('click', () => {
            const muted = UvacSIP.toggleMute();
            const btn = document.getElementById('muteBtn');
            if (muted) {
                btn.classList.add('active');
                btn.innerHTML = '<i class="ti ti-microphone-off"></i>';
                btn.title = 'Activar micrófono';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '<i class="ti ti-microphone"></i>';
                btn.title = 'Silenciar';
            }
        });

        document.getElementById('transferBtn').addEventListener('click', () => {
            document.getElementById('transferModal').classList.remove('hidden');
            document.getElementById('transferNumber').value = '';
            document.getElementById('transferNumber').focus();
        });

        // Botón "ventana flotante" (Document Picture-in-Picture). Solo escritorio
        // y navegador compatible; app.js decide cuándo mostrarlo.
        const floatBtn = document.getElementById('floatBtn');
        if (floatBtn) {
            floatBtn.addEventListener('click', () => self._openFloatingWidget());
        }

        // Botón altavoz / manos libres (solo móvil)
        const speakerBtn = document.getElementById('speakerBtn');
        if (speakerBtn) {
            speakerBtn.addEventListener('click', () => {
                self._toggleSpeaker();
            });
        }
    },

    /**
     * Toggle altavoz / manos libres
     * Aumenta volumen al máximo y previene cuelgue por proximidad
     */
    _toggleSpeaker: function() {
        const btn = document.getElementById('speakerBtn');
        const audio = document.getElementById('remoteAudio');

        if (!audio) return;

        this.speakerActive = !this.speakerActive;

        if (this.speakerActive) {
            // Activar manos libres
            audio.volume = 1.0;
            btn.classList.add('active');
            btn.innerHTML = '<i class="ti ti-volume"></i>';
            btn.title = 'Manos libres ACTIVO';

            // Vibración háptica (si está disponible)
            if (navigator.vibrate) navigator.vibrate(50);

            uvacLog('🔊 Manos libres activado');

            // Intentar usar el altavoz principal (sinkId si está disponible)
            if (audio.setSinkId && navigator.mediaDevices) {
                navigator.mediaDevices.enumerateDevices().then(devices => {
                    const speakers = devices.filter(d => d.kind === 'audiooutput');
                    if (speakers.length > 1) {
                        // Buscar altavoz principal (no audifono)
                        const speaker = speakers.find(d =>
                            d.label.toLowerCase().includes('speaker') ||
                            d.label.toLowerCase().includes('altavoz') ||
                            d.deviceId === 'default'
                        );
                        if (speaker) {
                            audio.setSinkId(speaker.deviceId).catch(() => {});
                        }
                    }
                });
            }
        } else {
            // Desactivar manos libres
            audio.volume = 0.85;
            btn.classList.remove('active');
            btn.innerHTML = '<i class="ti ti-volume"></i>';
            btn.title = 'Activar manos libres';

            if (navigator.vibrate) navigator.vibrate(30);

            uvacLog('🎧 Manos libres desactivado');
        }
    },

    /**
     * Solicitar Wake Lock para mantener pantalla activa durante llamada
     */
    _requestWakeLock: async function() {
        if (!('wakeLock' in navigator)) {
            uvacLog('⚠️ Wake Lock no soportado en este navegador');
            return;
        }

        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            uvacLog('🔆 Pantalla bloqueada activa (wake lock)');

            this.wakeLock.addEventListener('release', () => {
                uvacLog('🔓 Wake lock liberado');
            });
        } catch (err) {
            uvacError('Error al solicitar wake lock:', err);
        }
    },

    /**
     * Liberar Wake Lock
     */
    _releaseWakeLock: function() {
        if (this.wakeLock) {
            this.wakeLock.release().then(() => {
                this.wakeLock = null;
                uvacLog('🔓 Wake lock liberado manualmente');
            });
        }
    },

    /**
     * Hacer llamada saliente
     */
    _makeCall: function() {
        let number = document.getElementById('numberDisplay').value.trim();

        if (!number) {
            // No es un fallo de llamada: simplemente no hay número marcado.
            // (Evita el falso modal "No se pudo realizar la llamada" que salía
            //  por toques accidentales al botón de llamar, p.ej. cuando una
            //  llamada entrante se cancela y el botón "Contestar" se reemplaza
            //  por el de "Llamar" justo bajo el dedo del usuario.)
            uvacLog('Intento de llamada sin número: ignorado');
            const display = document.getElementById('numberDisplay');
            if (display) display.focus();
            return;
        }

        // Limpiar el número: quitar +, espacios, guiones, paréntesis.
        // Solo dejar dígitos, * y # (necesarios para códigos de servicio Asterisk).
        // El "+" causa "404 Not Found" porque FreePBX no enruta números con prefijo +.
        const cleaned = number.replace(/[^\d*#]/g, '');

        if (!cleaned) {
            UvacAlerts.show('CALL_FAILED', { details: 'Número inválido' });
            return;
        }

        // Si limpiamos algo, avisamos en log para debugging
        if (cleaned !== number) {
            uvacLog('📞 Número normalizado: "' + number + '" → "' + cleaned + '"');
        }

        number = cleaned;

        if (!UvacSIP.isRegistered) {
            // Mostrar alerta clara con opción de reconectar
            this._showOfflineAlert();
            return;
        }

        this.currentCallNumber = number;
        this.isInCall = true;

        if (UvacSIP.makeCall(number)) {
            this._showActiveCall(number, 'outgoing');
            if (typeof UvacReporter !== 'undefined') UvacReporter.callStarted('saliente', number);
        }
    },

    /**
     * Mostrar panel de llamada activa
     */
    _showActiveCall: function(number, direction) {
        // Identificar país y bandera del número (entrante o saliente)
        let info = null;
        if (typeof UvacCallerID !== 'undefined') {
            try {
                info = UvacCallerID.identify(number);
            } catch (e) {
                info = null;
            }
        }

        // Mostrar el número formateado si lo tenemos, sino el crudo
        const callNumberEl = document.getElementById('callNumber');
        if (callNumberEl) {
            callNumberEl.textContent = (info && info.formatted) ? info.formatted : number;
        }
        document.getElementById('callTimer').textContent = '00:00';
        document.getElementById('activeCallPanel').classList.remove('hidden');

        // Actualizar avatar: ahora bandera circular del país en lugar de iniciales
        const avatarEl = document.getElementById('avatar');
        if (avatarEl) {
            if (info && info.flagSvg) {
                avatarEl.textContent = '';
                avatarEl.innerHTML = info.flagSvg;
                const svg = avatarEl.querySelector('svg');
                if (svg) {
                    svg.setAttribute('width', '100%');
                    svg.setAttribute('height', '100%');
                }
            } else {
                // Fallback al comportamiento original
                const numStr = String(number);
                avatarEl.innerHTML = '';
                avatarEl.textContent = numStr.length >= 2 ? numStr.substring(0, 2) : numStr;
            }
        }

        // Mostrar botón colgar y ocultar llamar durante la llamada
        const callBtn = document.getElementById('callBtn');
        const hangupBtn = document.getElementById('hangupBtn');
        if (callBtn) callBtn.classList.add('hidden');
        if (hangupBtn) hangupBtn.classList.remove('hidden');

        // Mostrar tip de "no cerrar navegador" en móvil
        if (this.isMobile) {
            document.getElementById('mobileCallTip').classList.remove('hidden');
            // Vibración al iniciar llamada
            if (navigator.vibrate) navigator.vibrate(100);
        }

        // Solicitar Wake Lock para mantener pantalla activa
        this._requestWakeLock();

        // El altavoz NO se activa automáticamente.
        // El usuario decide si quiere usar altavoz (botón 🔊) o auricular (default).

        // País como subtítulo del estado (más útil que solo "Llamando...")
        const countryLabel = (info && info.country) ? ' · ' + info.country : '';

        if (direction === 'outgoing') {
            document.getElementById('callStatus').textContent = 'Llamando...' + countryLabel;
            document.getElementById('answerBtn').classList.add('hidden');
        } else {
            document.getElementById('callStatus').textContent = 'Llamada entrante' + countryLabel;
            document.getElementById('answerBtn').classList.remove('hidden');
            this._playRingtone();

            // Vibración patrón de llamada entrante
            if (this.isMobile && navigator.vibrate) {
                navigator.vibrate([300, 200, 300, 200, 300]);
            }
        }

        // Mostrar el botón de ventana flotante (solo escritorio compatible)
        this._updateFloatBtnVisibility();
    },

    /**
     * Solicitar permiso de notificaciones del sistema.
     * En PC suele aparecer prompt automático.
     * En celular muchas veces el navegador requiere acción manual del usuario,
     * por eso también mostramos un banner con botón "Activar".
     */
    _requestNotificationPermission: function() {
        try {
            if (typeof Notification === 'undefined') {
                uvacLog('Notification API no disponible en este navegador');
                return;
            }

            // Si ya se concedió, ocultar banner por si estaba visible
            if (Notification.permission === 'granted') {
                uvacLog('🔔 Permiso de notificaciones ya concedido');
                this._hideNotifBanner();
                return;
            }

            // Si fue denegado o pendiente, mostrar banner manual
            // (el banner permite reintentar incluso si fue denegado)
            this._showNotifBanner();

            // Intentar pedirlo automáticamente (puede que el navegador lo permita)
            if (Notification.permission === 'default') {
                Notification.requestPermission().then((permission) => {
                    if (permission === 'granted') {
                        uvacLog('🔔 Permiso de notificaciones concedido (auto)');
                        this._hideNotifBanner();
                    } else {
                        uvacLog('🔕 Permiso no concedido auto - usar botón manual');
                    }
                }).catch(() => {});
            }
        } catch (err) {
            uvacWarn('No se pudo solicitar permiso de notificaciones:', err.message);
        }
    },

    /**
     * Mostrar el banner amarillo "Activa las notificaciones"
     */
    _showNotifBanner: function() {
        const banner = document.getElementById('notifBanner');
        if (banner) banner.classList.remove('hidden');
    },

    /**
     * Ocultar el banner cuando ya hay permiso
     */
    _hideNotifBanner: function() {
        const banner = document.getElementById('notifBanner');
        if (banner) banner.classList.add('hidden');
    },

    /**
     * Botón "Activar" del banner - se llama desde el click del usuario
     * Importante: el navegador SOLO permite pedir permiso desde click directo del usuario
     */
    _onClickEnableNotif: function() {
        const self = this;
        try {
            if (typeof Notification === 'undefined') {
                UvacAlerts.show({
                    type: 'warning',
                    title: 'No disponible',
                    message: 'Tu navegador no soporta notificaciones.',
                    buttonText: 'Entendido'
                });
                return;
            }

            Notification.requestPermission().then((permission) => {
                if (permission === 'granted') {
                    uvacLog('🔔 Permiso concedido por botón manual');
                    self._hideNotifBanner();
                    // Notificación de prueba para confirmar
                    try {
                        new Notification('🎉 Notificaciones activadas', {
                            body: 'Ya recibirás aviso cuando entre una llamada',
                            icon: 'img/allemm-logo.svg',
                            tag: 'uvac-test'
                        });
                    } catch (e) {}
                } else if (permission === 'denied') {
                    UvacAlerts.show({
                        type: 'warning',
                        title: 'Notificaciones bloqueadas',
                        message: 'Las notificaciones están bloqueadas en este navegador. Para activarlas, ve a la configuración del sitio (toca el candado 🔒 junto a la dirección) y permite las notificaciones.',
                        buttonText: 'Entendido'
                    });
                }
            }).catch((err) => {
                uvacWarn('Error pidiendo permiso:', err.message);
            });
        } catch (err) {
            uvacWarn('Error en activación manual:', err.message);
        }
    },

    _showIncomingCall: function(caller) {
        this.currentCallNumber = caller;
        this.isInCall = true;
        this._showActiveCall(caller, 'incoming');
        this._updateStatus('Llamada entrante', 'warning');

        // Disparar notificación del sistema (opcional, no rompe si falla)
        this._showCallNotification(caller);
    },

    /**
     * Mostrar notificación del sistema con la llamada entrante.
     * Si el usuario toca la notificación, la PWA se enfoca al frente.
     * Solo funciona si el usuario aceptó el permiso de notificaciones.
     */
    _showCallNotification: function(caller) {
        try {
            // Si el navegador no soporta Notification, salir
            if (typeof Notification === 'undefined') return;

            // Si no hay permiso, salir (no pedir aquí, ya se pidió al login)
            if (Notification.permission !== 'granted') {
                uvacLog('🔕 Notif no mostrada: sin permiso');
                return;
            }

            // Crear la notificación SIEMPRE (esté la app al frente o atrás)
            const notif = new Notification('📞 Llamada entrante', {
                body: `${caller} te está llamando`,
                icon: 'img/allemm-logo.svg',
                badge: 'img/allemm-logo.svg',
                tag: 'uvac-incoming-call',
                requireInteraction: true,
                silent: false,
                vibrate: [200, 100, 200, 100, 200]
            });

            // Al tocar la notificación, enfocar la PWA
            notif.onclick = () => {
                window.focus();
                if (notif.close) notif.close();
            };

            // Guardar referencia para cerrarla al colgar/contestar
            this._currentNotification = notif;

            uvacLog('🔔 Notificación de llamada entrante mostrada');
        } catch (err) {
            uvacWarn('No se pudo mostrar notificación:', err.message);
        }
    },

    /**
     * Cerrar la notificación actual si existe
     */
    _closeCallNotification: function() {
        try {
            if (this._currentNotification) {
                this._currentNotification.close();
                this._currentNotification = null;
            }
        } catch (err) {
            // ignorar
        }
    },

    /**
     * Terminar llamada activa
     */
    _endActiveCall: function() {
        document.getElementById('activeCallPanel').classList.add('hidden');
        document.getElementById('mobileCallTip').classList.add('hidden');
        document.getElementById('ringtone').pause();
        document.getElementById('ringtone').currentTime = 0;
        // Garantizar detención del ringback nuevo (por si quedó sonando)
        if (typeof UvacRingback !== 'undefined') {
            UvacRingback.stop();
        }
        this.isInCall = false;
        // Cerrar notificación de llamada entrante si existe
        this._closeCallNotification();

        // Cerrar la ventana flotante y ocultar su botón (la llamada terminó)
        this._closeFloatingWidget();
        this._updateFloatBtnVisibility();

        // Reset visual del callbar (volver al estado inicial)
        const callNumberEl = document.getElementById('callNumber');
        const callStatusEl = document.getElementById('callStatus');
        const callTimerEl = document.getElementById('callTimer');
        const avatarEl = document.getElementById('avatar');
        const answerBtn = document.getElementById('answerBtn');
        const callBtn = document.getElementById('callBtn');
        const hangupBtn = document.getElementById('hangupBtn');

        if (callNumberEl) callNumberEl.textContent = 'Sin llamada activa';
        if (callStatusEl) callStatusEl.textContent = 'Marca un número para iniciar';
        if (callTimerEl) callTimerEl.textContent = '00:00';
        if (avatarEl) {
            avatarEl.innerHTML = '';
            avatarEl.textContent = '--';
        }
        if (answerBtn) answerBtn.classList.add('hidden');
        if (hangupBtn) hangupBtn.classList.add('hidden');
        if (callBtn) callBtn.classList.remove('hidden');

        // Liberar wake lock
        this._releaseWakeLock();

        // Resetear altavoz
        if (this.speakerActive) {
            const btn = document.getElementById('speakerBtn');
            btn.classList.remove('active');
            this.speakerActive = false;
        }

        // Vibración corta al colgar
        if (this.isMobile && navigator.vibrate) navigator.vibrate(80);

        this._updateStatus('Conectado', 'success');
    },

    /**
     * Configurar atajos de teclado (igual que el .exe)
     */
    _setupKeyboardShortcuts: function() {
        const self = this;
        const display = document.getElementById('numberDisplay');

        document.addEventListener('keydown', (e) => {
            // No interferir si está en login, transfer o alerta
            if (!document.getElementById('loginScreen').classList.contains('hidden')) return;
            if (!document.getElementById('transferModal').classList.contains('hidden')) return;
            if (!document.getElementById('alertModal').classList.contains('hidden')) return;

            // NO interferir si el foco está en CUALQUIER input, textarea o campo editable
            // (notas, dialer, etc. - el navegador maneja el borrado nativo)
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) {
                return;
            }

            // Si NO está en ningún campo, agregar números al display del dialer
            if (/^[0-9*#]$/.test(e.key)) {
                if (UvacSIP.currentSession && UvacSIP.currentSession.isEstablished()) {
                    UvacSIP.sendDTMF(e.key);
                } else {
                    display.value += e.key;
                    e.preventDefault();
                }
            }
            else if (e.key === 'Backspace' || e.key === 'Delete') {
                // Borrar el último número del dialer (solo si no estás escribiendo en otro lado)
                if (!self.isInCall) {
                    display.value = display.value.slice(0, -1);
                    e.preventDefault();
                }
            }
            else if (e.key === 'Escape') {
                if (self.isInCall) {
                    UvacSIP.hangup();
                }
                e.preventDefault();
            }
            else if (e.ctrlKey && e.key === 'v') {
                if (!self.isInCall) {
                    navigator.clipboard.readText().then(text => {
                        const cleaned = text.replace(/[^0-9*#+]/g, '');
                        display.value += cleaned;
                    }).catch(() => {});
                }
            }
            // Nota: Enter intencionalmente NO hace nada (ni llamar ni contestar)
            // Para llamar/contestar/colgar, usa los botones de la pantalla
        });
    },

    /**
     * Configurar modal de transferencia
     */
    _setupTransferModal: function() {
        const self = this;
        const modal = document.getElementById('transferModal');
        const transferDisplay = document.getElementById('transferNumber');

        document.querySelectorAll('.transfer-key').forEach(btn => {
            btn.addEventListener('click', () => {
                transferDisplay.value += btn.dataset.key;
            });
        });

        document.getElementById('cancelTransferBtn').addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        document.getElementById('confirmTransferBtn').addEventListener('click', () => {
            const num = transferDisplay.value.trim();
            if (!num) return;
            if (UvacSIP.transfer(num)) {
                modal.classList.add('hidden');
                self._updateStatus('Transferencia enviada', 'success');
            }
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    },

    /**
     * Actualizar barra de estado
     */
    _updateStatus: function(text, type) {
        const el = document.getElementById('statusLabel');
        el.textContent = text;

        const bar = el.parentElement;
        bar.style.background = {
            'success': 'var(--uvac-blue)',
            'warning': 'var(--uvac-warning)',
            'error': 'var(--uvac-danger)'
        }[type] || 'var(--uvac-blue)';
    },

    /**
     * Historial de llamadas
     */
    _addToHistory: function(number, type) {
        if (!number) return;

        const entry = {
            number: number,
            type: type,
            timestamp: new Date().toISOString()
        };

        this.callHistory.unshift(entry);

        // Conservar solo lo de los últimos N días (config.historyRetentionDays)
        this._purgeOldHistory();

        // Tope de seguridad para no llenar el almacenamiento del navegador
        if (this.callHistory.length > 200) this.callHistory.length = 200;

        localStorage.setItem('uvac_history', JSON.stringify(this.callHistory));
        this._renderHistory();
    },

    /**
     * Borra del historial las llamadas más viejas que N días
     * (N = UVAC_CONFIG.historyRetentionDays, por defecto 6).
     * Solo filtra el arreglo en memoria; el guardado lo hace quien la llama.
     */
    _purgeOldHistory: function() {
        const days = (typeof UVAC_CONFIG !== 'undefined' && UVAC_CONFIG.historyRetentionDays)
            ? UVAC_CONFIG.historyRetentionDays : 6;
        const maxAgeMs = days * 24 * 60 * 60 * 1000;
        const now = Date.now();
        this.callHistory = this.callHistory.filter(e => {
            const t = (e && e.timestamp) ? new Date(e.timestamp).getTime() : NaN;
            // Conservar si no tiene fecha válida (no podemos saber su edad) o
            // si está dentro de la ventana de días.
            return isNaN(t) || (now - t) < maxAgeMs;
        });
    },

    _loadHistory: function() {
        try {
            const stored = localStorage.getItem('uvac_history');
            if (stored) {
                this.callHistory = JSON.parse(stored) || [];
                // Limpiar lo viejo al abrir y volver a guardar ya depurado
                this._purgeOldHistory();
                localStorage.setItem('uvac_history', JSON.stringify(this.callHistory));
                this._renderHistory();
            }
        } catch (e) {
            uvacError('Error cargando historial:', e);
        }
    },

    _renderHistory: function() {
        const list = document.getElementById('historyList');
        const listView = document.getElementById('historyListView');
        const self = this;

        // Render seguro: el número del llamante puede venir del campo From
        // de un INVITE entrante (controlable por el peer). Usamos textContent
        // y createElement para evitar XSS si alguien manda HTML en ese campo.
        const renderTo = (container) => {
            if (!container) return;

            container.textContent = '';

            if (self.callHistory.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'history-empty';
                empty.textContent = 'Sin llamadas recientes';
                container.appendChild(empty);
                return;
            }

            const icons = {
                'outgoing': '↗',
                'completed': '↗',
                'incoming': '↙',
                'missed': '✕'
            };

            self.callHistory.forEach(entry => {
                const date = new Date(entry.timestamp);
                const timeStr = date.toLocaleString('es-MX', {
                    day: '2-digit', month: '2-digit',
                    hour: '2-digit', minute: '2-digit'
                });

                const iconClass = entry.type === 'missed' ? 'missed' :
                                  (entry.type === 'incoming' ? 'incoming' : 'outgoing');

                const item = document.createElement('div');
                item.className = 'history-item';
                item.dataset.number = entry.number;

                const iconEl = document.createElement('span');
                iconEl.className = 'history-icon ' + iconClass;
                iconEl.textContent = icons[entry.type] || '•';
                item.appendChild(iconEl);

                const details = document.createElement('div');
                details.className = 'history-details';

                const numEl = document.createElement('div');
                numEl.className = 'history-number';
                numEl.textContent = entry.number;
                details.appendChild(numEl);

                const timeEl = document.createElement('div');
                timeEl.className = 'history-time';
                timeEl.textContent = timeStr;
                details.appendChild(timeEl);

                item.appendChild(details);

                item.addEventListener('click', () => {
                    document.getElementById('numberDisplay').value = entry.number;
                    self._showDialerView();
                });

                container.appendChild(item);
            });
        };

        renderTo(list);
        renderTo(listView);
    },

    /**
     * Cambiar a vista del Dialer (marcador)
     */
    _showDialerView: function() {
        const dialer = document.getElementById('dialerView');
        const history = document.getElementById('historyView');
        if (dialer) dialer.classList.remove('hidden');
        if (history) history.classList.add('hidden');

        // Activar tab Dialer en sidebar
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        const dialerTab = document.querySelector('.nav-btn[data-tab="dialer"]');
        if (dialerTab) dialerTab.classList.add('active');
    },

    /**
     * Cambiar a vista de Historial
     */
    _showHistoryView: function() {
        const dialer = document.getElementById('dialerView');
        const history = document.getElementById('historyView');
        if (dialer) dialer.classList.add('hidden');
        if (history) history.classList.remove('hidden');

        // Activar tab Historial en sidebar
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        const historyTab = document.querySelector('.nav-btn[data-tab="history"]');
        if (historyTab) historyTab.classList.add('active');

        // Refrescar el render por si hay llamadas nuevas
        this._renderHistory();
    }
};

// Inicializar cuando el DOM esté listo
// Compatible con carga dinámica (después de DOMContentLoaded)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        UvacApp.init();
    });
} else {
    // DOM ya cargado — inicializar inmediatamente
    UvacApp.init();
}

// Atajo secreto: Ctrl+Shift+L para descargar logs (útil para soporte)
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        UvacAlerts.downloadLog();
        e.preventDefault();
    }
});

/* ============================================
   MÓDULO DE NOTAS DE LLAMADA
   Sistema independiente - no afecta SIP
   Almacena notas en localStorage
   ============================================ */
const UvacNotes = {

    storageKey: 'uvacSIP_notes',

    /**
     * Inicializar el sistema de notas
     */
    init: function() {
        const saveBtn = document.getElementById('saveNote');
        const clearBtn = document.getElementById('clearNotesBtn');
        const noteText = document.getElementById('noteText');

        if (!saveBtn || !noteText) {
            // No hay panel de notas en este HTML, salir silenciosamente
            return;
        }

        const self = this;

        saveBtn.addEventListener('click', () => {
            self._saveNote();
        });

        // Atajo: Ctrl+Enter para guardar
        noteText.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                self._saveNote();
                e.preventDefault();
            }
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('¿Borrar TODAS las notas guardadas?')) {
                    self._clearAllNotes();
                }
            });
        }

        this._renderNotes();
    },

    /**
     * Guardar una nota nueva
     */
    _saveNote: function() {
        const noteText = document.getElementById('noteText');
        const text = noteText.value.trim();

        if (!text) {
            noteText.focus();
            return;
        }

        const notes = this._getNotes();
        const newNote = {
            id: Date.now(),
            text: text,
            timestamp: new Date().toISOString(),
            callNumber: (typeof UvacApp !== 'undefined' && UvacApp.currentCallNumber) ? UvacApp.currentCallNumber : null
        };

        notes.unshift(newNote);
        this._saveNotes(notes);
        noteText.value = '';
        this._renderNotes();
    },

    /**
     * Borrar una nota específica
     */
    _deleteNote: function(id) {
        const notes = this._getNotes().filter(n => n.id !== id);
        this._saveNotes(notes);
        this._renderNotes();
    },

    /**
     * Borrar todas las notas
     */
    _clearAllNotes: function() {
        this._saveNotes([]);
        this._renderNotes();
    },

    /**
     * Obtener notas guardadas
     */
    _getNotes: function() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Guardar notas en localStorage
     */
    _saveNotes: function(notes) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(notes));
        } catch (e) {
            console.error('Error al guardar nota:', e);
        }
    },

    /**
     * Renderizar la lista de notas en el DOM
     */
    _renderNotes: function() {
        const list = document.getElementById('notesList');
        if (!list) return;

        const notes = this._getNotes();

        if (notes.length === 0) {
            list.innerHTML = '<div class="notes-empty">Sin notas guardadas</div>';
            return;
        }

        const self = this;
        list.innerHTML = '';

        notes.forEach(note => {
            const item = document.createElement('div');
            item.className = 'note-item';
            item.dataset.noteId = note.id;

            const date = new Date(note.timestamp);
            const dateStr = date.toLocaleDateString('es-MX', {
                day: '2-digit',
                month: '2-digit'
            }) + ' ' + date.toLocaleTimeString('es-MX', {
                hour: '2-digit',
                minute: '2-digit'
            });

            // Vista normal
            const viewMode = document.createElement('div');
            viewMode.className = 'note-view-mode';

            const content = document.createElement('div');
            content.className = 'note-item-content';
            content.textContent = note.text;

            const metaRow = document.createElement('div');
            metaRow.className = 'note-item-meta';

            const metaText = document.createElement('span');
            metaText.className = 'note-item-date';
            metaText.textContent = note.callNumber ? `${dateStr} · ${note.callNumber}` : dateStr;

            // Botones grandes y visibles
            const actions = document.createElement('div');
            actions.className = 'note-item-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'note-action-btn note-edit-btn';
            editBtn.innerHTML = '<i class="ti ti-edit"></i>';
            editBtn.title = 'Editar nota';
            editBtn.addEventListener('click', () => {
                self._enterEditMode(note.id);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'note-action-btn note-delete-btn';
            deleteBtn.innerHTML = '<i class="ti ti-trash"></i>';
            deleteBtn.title = 'Borrar nota';
            deleteBtn.addEventListener('click', () => {
                if (confirm('¿Borrar esta nota?')) {
                    self._deleteNote(note.id);
                }
            });

            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);

            metaRow.appendChild(metaText);
            metaRow.appendChild(actions);

            viewMode.appendChild(content);
            viewMode.appendChild(metaRow);

            // Vista de edición (oculta por defecto)
            const editMode = document.createElement('div');
            editMode.className = 'note-edit-mode hidden';

            const editTextarea = document.createElement('textarea');
            editTextarea.className = 'note-edit-textarea';
            editTextarea.value = note.text;

            const editActions = document.createElement('div');
            editActions.className = 'note-edit-actions';

            const saveEditBtn = document.createElement('button');
            saveEditBtn.className = 'note-edit-save';
            saveEditBtn.innerHTML = '<i class="ti ti-check"></i> Guardar';
            saveEditBtn.addEventListener('click', () => {
                self._saveEdit(note.id, editTextarea.value);
            });

            const cancelEditBtn = document.createElement('button');
            cancelEditBtn.className = 'note-edit-cancel';
            cancelEditBtn.innerHTML = '<i class="ti ti-x"></i> Cancelar';
            cancelEditBtn.addEventListener('click', () => {
                self._exitEditMode(note.id);
            });

            editActions.appendChild(saveEditBtn);
            editActions.appendChild(cancelEditBtn);

            editMode.appendChild(editTextarea);
            editMode.appendChild(editActions);

            item.appendChild(viewMode);
            item.appendChild(editMode);
            list.appendChild(item);
        });
    },

    /**
     * Entrar en modo edición de una nota
     */
    _enterEditMode: function(id) {
        const item = document.querySelector(`[data-note-id="${id}"]`);
        if (!item) return;

        const viewMode = item.querySelector('.note-view-mode');
        const editMode = item.querySelector('.note-edit-mode');
        const textarea = item.querySelector('.note-edit-textarea');

        if (viewMode) viewMode.classList.add('hidden');
        if (editMode) editMode.classList.remove('hidden');
        if (textarea) {
            textarea.focus();
            // Cursor al final del texto
            const len = textarea.value.length;
            textarea.setSelectionRange(len, len);
        }
    },

    /**
     * Salir del modo edición sin guardar
     */
    _exitEditMode: function(id) {
        const item = document.querySelector(`[data-note-id="${id}"]`);
        if (!item) return;

        const viewMode = item.querySelector('.note-view-mode');
        const editMode = item.querySelector('.note-edit-mode');

        if (editMode) editMode.classList.add('hidden');
        if (viewMode) viewMode.classList.remove('hidden');
    },

    /**
     * Guardar cambios de una edición
     */
    _saveEdit: function(id, newText) {
        const text = newText.trim();
        if (!text) {
            alert('La nota no puede estar vacía');
            return;
        }

        const notes = this._getNotes();
        const note = notes.find(n => n.id === id);
        if (note) {
            note.text = text;
            note.editedAt = new Date().toISOString();
            this._saveNotes(notes);
            this._renderNotes();
        }
    }
};

// Inicializar notas cuando la app esté lista
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UvacNotes.init());
} else {
    setTimeout(() => UvacNotes.init(), 100);
}
