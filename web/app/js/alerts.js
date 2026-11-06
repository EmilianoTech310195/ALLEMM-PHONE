/* ========================================
   ALLEMM SIP Web - Sistema de Alertas y Logs
   ========================================
   Maneja todas las alertas al usuario y logs
   detallados en consola para soporte/IT.
   ======================================== */

const AllemmAlerts = {

    // Estado interno
    currentAlertType: null,
    retryCallback: null,
    retryCountdownInterval: null,
    retryAttempt: 0,

    // Helper: obtiene un elemento del DOM de forma segura.
    // Si no existe (ej: en el widget reducido), devuelve un objeto "dummy"
    // que absorbe cualquier operación sin tronar.
    _el: function(id) {
        const e = document.getElementById(id);
        if (e) return e;
        // Dummy inofensivo: classList, onclick, innerHTML, etc. no hacen nada
        return {
            classList: { add: function(){}, remove: function(){}, toggle: function(){} },
            style: {},
            set innerHTML(v) {}, get innerHTML() { return ''; },
            set textContent(v) {}, get textContent() { return ''; },
            set onclick(v) {}, get onclick() { return null; },
            set className(v) {}, get className() { return ''; },
            set title(v) {}, get title() { return ''; }
        };
    },

    // ¿Existe el modal de alertas en esta página? (la app sí, el widget no)
    _tieneDOM: function() {
        return this._el('alertModal') !== null;
    },

    // Catálogo de errores conocidos con mensajes amigables
    errorCatalog: {
        // Errores de red/conexión
        'NO_INTERNET': {
            icon: '🌐',
            title: 'Sin conexión a internet',
            message: 'No detectamos conexión a internet en tu equipo.',
            causes: [
                'WiFi desconectado o sin señal',
                'Cable de red desconectado',
                'Datos móviles agotados'
            ],
            retryable: true
        },
        'WS_CONNECTION_FAILED': {
            icon: '🔌',
            title: 'No se pudo conectar al PBX',
            message: 'No pudimos establecer comunicación con el conmutador de ALLEMM.',
            causes: [
                'El servidor PBX está temporalmente fuera de servicio',
                'Tu firewall o antivirus bloquea la conexión',
                'Tu red corporativa bloquea WebSocket'
            ],
            retryable: true
        },
        'NETWORK_BLOCKED': {
            icon: '📶',
            title: 'Sin WiFi',
            message: 'No hay WiFi y el uso de datos móviles está desactivado en Ajustes.',
            causes: [
                'Conéctate a una red WiFi, o',
                'Activa "Red móvil" en Ajustes para usar tu plan de datos'
            ],
            retryable: true
        },
        'PBX_BLOCKED_AFTER_AUTH': {
            icon: '🔒',
            title: 'El PBX dejó de responder',
            message: 'Hubo una contraseña incorrecta y el PBX bloqueó temporalmente esta computadora (protección contra intentos fallidos).',
            causes: [
                'Verifica la extensión y la contraseña SIP con el administrador',
                'Espera 10 a 30 minutos antes de volver a intentar',
                'El administrador puede desbloquear la IP en FreePBX → Intrusion Detection'
            ],
            retryable: true
        },
        'WS_DISCONNECTED': {
            icon: '📡',
            title: 'Conexión perdida',
            message: 'Se perdió la conexión con el PBX.',
            causes: [
                'Tu internet se desconectó momentáneamente',
                'El servidor se reinició'
            ],
            retryable: true
        },

        // Errores de autenticación
        'AUTH_401': {
            icon: '🔑',
            title: 'Credenciales incorrectas',
            message: 'La extensión o contraseña SIP son incorrectas.',
            causes: [
                'Verificar el número de extensión',
                'Verificar la contraseña SIP (no es la del portal web)',
                'Contactar a IT si el problema persiste'
            ],
            retryable: false
        },
        'AUTH_403': {
            icon: '🚫',
            title: 'Acceso denegado',
            message: 'Tu extensión está bloqueada o no tiene permisos.',
            causes: [
                'La extensión fue desactivada en el PBX',
                'Múltiples intentos fallidos bloquearon la cuenta',
                'Contacta a IT para desbloqueo'
            ],
            retryable: false
        },

        // Errores de servidor
        'SERVER_TIMEOUT': {
            icon: '⏱️',
            title: 'El servidor no responde',
            message: 'El PBX tardó demasiado en responder.',
            causes: [
                'Servidor saturado',
                'Conexión lenta de internet',
                'Problemas temporales de red'
            ],
            retryable: true
        },
        'SERVER_500': {
            icon: '🔧',
            title: 'Error del servidor',
            message: 'El PBX presenta problemas internos.',
            causes: [
                'Mantenimiento del servidor',
                'Falla temporal — intentar más tarde',
                'Contactar a IT si persiste'
            ],
            retryable: true
        },

        // Errores de WebRTC / audio
        'MIC_DENIED': {
            icon: '🎤',
            title: 'Micrófono bloqueado',
            message: 'Necesitas permitir acceso al micrófono para hacer llamadas.',
            causes: [
                'Click en el ícono 🔒 de la barra de URL',
                'Selecciona "Permitir" para el micrófono',
                'Recarga la página después de permitir'
            ],
            retryable: false
        },
        'MIC_NOT_FOUND': {
            icon: '🎙️',
            title: 'Micrófono no detectado',
            message: 'No encontramos un micrófono conectado.',
            causes: [
                'Conectar audífonos o micrófono',
                'Verificar que esté reconocido por el sistema',
                'Probar con otro dispositivo'
            ],
            retryable: true
        },
        'NO_HTTPS': {
            icon: '🔒',
            title: 'Conexión no segura',
            message: 'La aplicación requiere HTTPS para funcionar.',
            causes: [
                'Accede usando https:// en lugar de http://',
                'Si ves este error, contacta a IT'
            ],
            retryable: false
        },
        'WEBRTC_UNSUPPORTED': {
            icon: '🌍',
            title: 'Navegador no compatible',
            message: 'Tu navegador no soporta llamadas de voz.',
            causes: [
                'Usar Chrome, Edge, Firefox o Safari actualizados',
                'Internet Explorer no es compatible'
            ],
            retryable: false
        },

        // Errores de llamada
        'CALL_FAILED': {
            icon: '📵',
            title: 'No se pudo realizar la llamada',
            message: 'La llamada falló al intentar conectar.',
            causes: [
                'Número incorrecto',
                'El destinatario no está disponible',
                'Sin saldo o ruta para llamadas externas'
            ],
            retryable: false
        },

        // El PBX recibió la llamada pero su troncal no tiene canal (503 / Q.850 34)
        'CALL_NO_LINE': {
            icon: '📡',
            title: 'El conmutador no tiene línea de salida',
            message: 'La llamada llegó al conmutador, pero su troncal no tiene canal disponible (código 503).',
            causes: [
                'La troncal del proveedor no está registrada o configurada',
                'Sin canales libres o sin saldo para llamadas externas',
                'La ruta de salida no acepta ese formato de número',
                'Prueba *43 (eco) o una extensión: si funcionan, la app está bien'
            ],
            retryable: false
        },
        'CALL_NOT_FOUND': {
            icon: '🔢',
            title: 'Número no encontrado',
            message: 'El conmutador no encontró ese número o extensión.',
            causes: [
                'Revisa el número (10 dígitos para celulares y fijos)',
                'La extensión no existe',
                'La ruta de salida no acepta ese formato de número'
            ],
            retryable: false
        },

        // Llamada entrante que ya fue atendida por otro agente (ring group / cola)
        'CALL_TAKEN': {
            icon: '✅',
            title: 'Llamada atendida por un compañero',
            message: 'La llamada ya fue tomada por un compañero.',
            causes: [],
            retryable: false,
            info: true   // informativo, no es un error → no se pinta de rojo en consola
        },

        // Genérico
        'UNKNOWN': {
            icon: '❓',
            title: 'Error desconocido',
            message: 'Ocurrió un error inesperado.',
            causes: [
                'Recarga la página (F5)',
                'Si persiste, contacta a IT con el detalle de la consola (F12)'
            ],
            retryable: true
        }
    },

    /**
     * Mostrar alerta al usuario
     * @param {string} errorCode - Código del catálogo (ej: 'AUTH_401')
     * @param {object} options - { details, retryCallback, autoRetry }
     */
    show: function(errorCode, options = {}) {
        const error = this.errorCatalog[errorCode] || this.errorCatalog['UNKNOWN'];

        // Log siempre, sin importar si se muestra modal
        this.logError(errorCode, error, options.details);

        // Llenar el modal
        this._el('alertIcon').textContent = error.icon;
        this._el('alertTitle').textContent = error.title;
        this._el('alertMessage').textContent = error.message;

        // Mostrar causas posibles
        const causesEl = this._el('alertCauses');
        if (error.causes && error.causes.length > 0) {
            // Construir <li> con textContent para evitar XSS si en algún
            // momento llega contenido del PBX en `causes` (e.cause, etc.)
            causesEl.textContent = '';
            error.causes.forEach(c => {
                const li = document.createElement('li');
                li.textContent = String(c);
                causesEl.appendChild(li);
            });
            causesEl.classList.remove('hidden');
        } else {
            causesEl.classList.add('hidden');
        }

        // Configurar botón de reintentar
        const retryBtn = this._el('alertRetryBtn');
        if (error.retryable && options.retryCallback) {
            retryBtn.classList.remove('hidden');
            this.retryCallback = options.retryCallback;
            retryBtn.onclick = () => this.executeRetry();
        } else {
            retryBtn.classList.add('hidden');
        }

        // Configurar botón cerrar
        this._el('alertCloseBtn').onclick = () => this.close();

        // Mostrar el modal
        this._el('alertModal').classList.remove('hidden');
        this.currentAlertType = errorCode;

        // Auto-reintento si está configurado
        if (options.autoRetry && error.retryable && options.retryCallback) {
            this.startAutoRetryCountdown(ALLEMM_CONFIG.retryDelay || 5);
        }
    },

    /**
     * Cerrar el modal de alerta
     */
    close: function() {
        this._el('alertModal').classList.add('hidden');
        this.stopAutoRetryCountdown();
        this.currentAlertType = null;
        this.retryCallback = null;
    },

    /**
     * Ejecutar reintento manual o automático
     */
    executeRetry: function() {
        this.stopAutoRetryCountdown();
        this.retryAttempt++;
        allemmLog(`🔄 Reintento #${this.retryAttempt}`);

        if (this.retryCallback) {
            const cb = this.retryCallback;
            this.close();
            try {
                cb();
            } catch (err) {
                allemmError('Error en reintento:', err);
            }
        }
    },

    /**
     * Iniciar countdown visual de auto-reintento
     */
    startAutoRetryCountdown: function(seconds) {
        const infoEl = this._el('alertRetryInfo');
        const countdownEl = this._el('alertRetryCountdown');

        infoEl.classList.remove('hidden');
        let remaining = seconds;
        countdownEl.textContent = remaining;

        this.retryCountdownInterval = setInterval(() => {
            remaining--;
            countdownEl.textContent = remaining;

            if (remaining <= 0) {
                this.executeRetry();
            }
        }, 1000);
    },

    /**
     * Detener countdown
     */
    stopAutoRetryCountdown: function() {
        if (this.retryCountdownInterval) {
            clearInterval(this.retryCountdownInterval);
            this.retryCountdownInterval = null;
        }
        this._el('alertRetryInfo').classList.add('hidden');
    },

    /**
     * Indicador de salud (punto de color en header)
     */
    setHealth: function(state) {
        const indicator = this._el('healthIndicator');
        if (!indicator) return;

        // Estados: 'ok', 'warning', 'error', 'offline'
        indicator.className = `health-indicator health-${state}`;

        const tooltips = {
            'ok': 'Conectado y funcionando',
            'warning': 'Conexión inestable',
            'error': 'Sin conexión al PBX',
            'offline': 'Desconectado'
        };
        indicator.title = tooltips[state] || '';
    },

    /**
     * Verificaciones pre-vuelo (antes de intentar conectar)
     * @returns {boolean} true si todo OK, false si hay problema
     */
    preflightCheck: function() {
        // El navegador exige HTTPS para el micrófono y WebRTC.
        if (!window.isSecureContext) {
            this.show('NO_HTTPS');
            return false;
        }
        if (typeof RTCPeerConnection === 'undefined' || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
            this.show('WEBRTC_UNSUPPORTED');
            return false;
        }
        if (typeof JsSIP === 'undefined' || !window.AllemmEngine) {
            this.show('UNKNOWN', { details: 'No se pudo cargar el motor SIP. Recarga la página.' });
            return false;
        }
        return true;
    },

    /**
     * Mapear causas del motor a códigos del catálogo (mismos nombres que JsSIP)
     */
    mapJsSipError: function(cause) {
        // JsSIP usa nombres específicos para cada tipo de error
        const map = {
            'Connection Error': 'WS_CONNECTION_FAILED',
            'WebSocket Error': 'WS_CONNECTION_FAILED',
            'Connection Timeout': 'SERVER_TIMEOUT',
            'Authentication Error': 'AUTH_401',
            'Forbidden': 'AUTH_403',
            'Request Timeout': 'SERVER_TIMEOUT',
            'Internal Server Error': 'SERVER_500',
            'Service Unavailable': 'SERVER_500',
            'User Denied Media Access': 'MIC_DENIED',
            'Canceled': 'CALL_FAILED',
            'Not Found': 'CALL_FAILED',
            'Busy': 'CALL_FAILED',
            'Rejected': 'CALL_FAILED',
            'Unavailable': 'CALL_FAILED'
        };

        return map[cause] || 'UNKNOWN';
    },

    /**
     * Causa de una llamada fallida → código del catálogo (usa también el código SIP).
     */
    mapCallFailure: function(cause, code) {
        code = parseInt(code, 10) || 0;
        if (code === 503 || cause === 'Service Unavailable') return 'CALL_NO_LINE';
        if (code === 404 || code === 484 || cause === 'Not Found' || cause === 'Address Incomplete') return 'CALL_NOT_FOUND';
        if (cause === 'SIP Failure Code' || (code >= 400 && code < 700)) return 'CALL_FAILED';
        return this.mapJsSipError(cause);
    },

    /**
     * Log detallado en consola para soporte/IT
     */
    logError: function(code, error, details) {
        const timestamp = new Date().toISOString();
        const userAgent = navigator.userAgent;
        const url = location.href;

        // Algunos códigos son solo informativos (no fallas), p.ej. CALL_TAKEN.
        // Para esos usamos un encabezado neutro en vez del "🚨 ERROR" rojo.
        const isInfo = error && error.info === true;
        if (isInfo) {
            console.group(`%cℹ️ [ALLEMM] ${code}`, 'color: #2563eb; font-weight: bold;');
        } else {
            console.group(`%c🚨 [ALLEMM ERROR] ${code}`, 'color: #dc2626; font-weight: bold;');
        }
        console.log('Timestamp:', timestamp);
        console.log('Code:', code);
        console.log('Title:', error.title);
        console.log('Message:', error.message);
        if (details) console.log('Details:', details);
        console.log('Browser:', userAgent);
        console.log('URL:', url);
        console.log('Online:', navigator.onLine);
        console.log('Config:', ALLEMM_CONFIG);
        console.groupEnd();

        // Guardar en log local (para descarga si se necesita)
        this.appendToLog({
            timestamp,
            code,
            title: error.title,
            message: error.message,
            details: details || null,
            url
        });
    },

    /**
     * Guardar log en sessionStorage (se borra al cerrar navegador)
     */
    appendToLog: function(entry) {
        try {
            let logs = JSON.parse(sessionStorage.getItem('allemm_error_log') || '[]');
            logs.push(entry);
            // Limitar a últimos 50 errores
            if (logs.length > 50) logs = logs.slice(-50);
            sessionStorage.setItem('allemm_error_log', JSON.stringify(logs));
        } catch (e) {
            // Si falla el storage, no romper la app
        }
    },

    /**
     * Descargar logs como archivo .txt
     * (Útil si IT pide los logs al usuario)
     */
    downloadLog: function() {
        try {
            const logs = JSON.parse(sessionStorage.getItem('allemm_error_log') || '[]');
            const text = `ALLEMM SIP - Log de errores
========================================
Generado: ${new Date().toISOString()}
Navegador: ${navigator.userAgent}
URL: ${location.href}
========================================

${logs.map(l => `[${l.timestamp}] ${l.code}
  Título: ${l.title}
  Mensaje: ${l.message}
  ${l.details ? 'Detalles: ' + JSON.stringify(l.details) : ''}
`).join('\n')}`;

            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `allemmsip_errores_${Date.now()}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            allemmError('Error al descargar log:', e);
        }
    },

    /**
     * Resetear contador de reintentos (al lograr conexión exitosa)
     */
    resetRetryCounter: function() {
        this.retryAttempt = 0;
    }
};

// Detectar cambios de conectividad de red automáticamente
window.addEventListener('online', () => {
    allemmLog('🟢 Internet recuperado');
    AllemmAlerts.setHealth('ok');
});

window.addEventListener('offline', () => {
    allemmLog('🔴 Internet perdido');
    AllemmAlerts.setHealth('error');
    AllemmAlerts.show('NO_INTERNET', {
        autoRetry: true,
        retryCallback: () => {
            if (navigator.onLine && typeof AllemmSIP !== 'undefined') {
                AllemmSIP.reconnect();
            }
        }
    });
});
