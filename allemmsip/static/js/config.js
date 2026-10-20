/* ========================================
   uvacSIP Web - Configuración del PBX
   ========================================
   IMPORTANTE: Cambia los valores según tu servidor.
   El puerto WSS y el path los confirma tu proveedor de PBX.
   ======================================== */

const UVAC_CONFIG = {

    // Servidor SIP: en la versión de escritorio se captura en Ajustes y se
    // guarda en settings.json. Este valor solo es un marcador.
    sipServer: '',

    // Puerto WebSocket Secure (WSS)
    // ⚠️ CAMBIAR según tu PBX. Valores comunes: 8089, 7443, 443
    wssPort: 8089,

    // Path del WebSocket (generalmente /ws)
    wssPath: '/ws',

    // Servidores STUN (para WebRTC / NAT traversal)
    // Se usan SOLO servidores de Google, que son rápidos y confiables.
    // ⚠️ NO volver a agregar stun.pjsip.org: estaba lento/caído y hacía que
    //    la llamada tardara ~40s en arrancar (el navegador lo esperaba antes
    //    de poder marcar). Quitarlo es lo que arregla ese retraso.
    stunServers: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302'
    ],

    // Tiempo de registro (segundos) — cada cuánto el teléfono "levanta la mano"
    // ante el PBX para poder recibir llamadas.
    // En COMPUTADORA: 600 (10 min), no se toca.
    registerExpires: 600,

    // En CELULAR: 120 (2 min). Como el celular duerme la app al bloquear la
    // pantalla, un registro más corto hace que se recupere y vuelvan a entrar
    // llamadas mucho más rápido al regresar. Solo aplica en móvil (ver sip.js).
    registerExpiresMobile: 120,

    // Timeout de llamada saliente (segundos)
    callTimeout: 60,

    // Códecs de audio preferidos (en orden)
    audioCodecs: ['PCMU', 'PCMA', 'opus'],

    // ========================================
    // HISTORIAL DE LLAMADAS
    // ========================================
    // Días que se conserva el historial de llamadas. Las llamadas más viejas
    // que esto se borran solas (al abrir la app y al registrar una nueva).
    historyRetentionDays: 6,

    // ========================================
    // TONOS DTMF (menús / IVR)
    // ========================================
    // Cómo se envían los tonos cuando aprietas números durante una llamada
    // (por ejemplo en un menú "marque 1 para...").
    //   'INFO'     → vía mensajes SIP INFO. Más confiable en PBX WebStudio/nube
    //                cuando RFC2833 no llega y el menú "no oye" el tono.
    //   'RFC2833'  → vía el audio (telephone-event). Es lo clásico, pero si el
    //                IVR no lo detecta, el menú se queda esperando ~60s.
    // Si uno no funciona, cambia a la otra opción y vuelve a probar.
    dtmfMode: 'INFO',

    // ========================================
    // SISTEMA DE REINTENTOS Y ALERTAS
    // ========================================

    // Reintento automático cada N segundos cuando se cae la conexión
    retryDelay: 5,

    // Máximo de reintentos automáticos antes de pedir intervención manual
    // 0 = infinito (NO recomendado durante pruebas)
    // 3-5 = balance entre tolerancia a microcortes y no saturar la consola
    maxRetries: 3,

    // Timeout en segundos para considerar el registro como fallido
    registerTimeout: 15,

    // Verificar conexión cada N segundos (heartbeat)
    healthCheckInterval: 30,

    // ========================================
    // CONFIGURACIÓN VISUAL
    // ========================================

    appName: 'Corporativo de Viajes UVAC',
    companyName: 'Corporativo de Viajes UVAC',
    footerText: 'Desarrollado por UVAC Tech',

    // Logs en consola.
    // ⚠️ En producción dejar en false: los logs de JsSIP con debug:true
    // muestran cabeceras Authorization (digest, nonce, realm) que ayudan
    // a un ataque offline contra la contraseña SIP si los logs se exfiltran.
    // Para diagnóstico puntual, IT puede activarlo desde DevTools con:
    //   UVAC_CONFIG.debug = true; JsSIP.debug.enable('JsSIP:*');
    debug: false
};

// Construir URL completa del WebSocket
UVAC_CONFIG.wssUrl = ''; // sin WebSocket en escritorio (SIP por UDP/TCP/TLS vía PJSIP)

// Función helper para logs condicionales
function uvacLog(...args) {
    if (UVAC_CONFIG.debug) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`%c[uvacSIP ${timestamp}]`, 'color: #1a5fd4; font-weight: bold;', ...args);
    }
}

function uvacError(...args) {
    const timestamp = new Date().toLocaleTimeString();
    console.error(`%c[uvacSIP ${timestamp} ERROR]`, 'color: #dc2626; font-weight: bold;', ...args);
}

function uvacWarn(...args) {
    if (UVAC_CONFIG.debug) {
        const timestamp = new Date().toLocaleTimeString();
        console.warn(`%c[uvacSIP ${timestamp} WARN]`, 'color: #f59e0b; font-weight: bold;', ...args);
    }
}
