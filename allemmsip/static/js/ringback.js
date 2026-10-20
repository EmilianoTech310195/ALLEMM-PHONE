/* ========================================
   uvacSIP Web - Ringback compatible con móvil
   ========================================
   Reproduce el tono de espera usando AudioContext
   en lugar de <audio> HTML, porque los navegadores
   móviles silencian el audio normal cuando WebRTC
   toma control de la sesión de audio.

   Esta técnica es la que usan Discord, WhatsApp Web,
   Google Meet, etc. para que el ringback se oiga en cel.
   ======================================== */

const UvacRingback = (function () {
    'use strict';

    // URL del MP3 — RUTA REAL en el servidor uvacSIP
    const RINGBACK_URL = 'sounds/ringback.mp3';

    // Estado interno
    let audioCtx = null;          // AudioContext compartido
    let audioBuffer = null;        // Buffer decodificado (se carga 1 sola vez)
    let sourceNode = null;         // Fuente activa (la que está sonando)
    let gainNode = null;           // Control de volumen
    let isLoading = false;         // Para evitar cargas duplicadas
    let isPlaying = false;         // Estado actual

    /**
     * Obtener o crear el AudioContext.
     * IMPORTANTE: debe crearse después de una interacción del usuario
     * (clic, tap) o el navegador lo bloquea.
     */
    function _getAudioContext() {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) {
                console.error('[Ringback] AudioContext no soportado en este navegador');
                return null;
            }
            audioCtx = new AC();
            console.log('[Ringback] AudioContext creado, estado:', audioCtx.state);
        }

        // Si el contexto está suspendido (común en móvil), reanudarlo
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log('[Ringback] AudioContext reanudado');
            }).catch(err => {
                console.error('[Ringback] Error reanudando AudioContext:', err);
            });
        }

        return audioCtx;
    }

    /**
     * Cargar y decodificar el MP3. Se hace una sola vez.
     */
    async function _loadBuffer() {
        if (audioBuffer || isLoading) return audioBuffer;

        isLoading = true;
        try {
            const ctx = _getAudioContext();
            if (!ctx) {
                isLoading = false;
                return null;
            }

            console.log('[Ringback] Descargando MP3:', RINGBACK_URL);
            const response = await fetch(RINGBACK_URL);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} al cargar ringback`);
            }

            const arrayBuffer = await response.arrayBuffer();
            console.log('[Ringback] MP3 descargado, decodificando...');

            // decodeAudioData devuelve una Promise en navegadores modernos
            audioBuffer = await ctx.decodeAudioData(arrayBuffer);
            console.log('[Ringback] MP3 decodificado:',
                audioBuffer.duration.toFixed(2) + 's,',
                audioBuffer.numberOfChannels + ' canales');

            isLoading = false;
            return audioBuffer;

        } catch (err) {
            console.error('[Ringback] Error cargando MP3:', err);
            isLoading = false;
            return null;
        }
    }

    /**
     * Pre-cargar el ringback (llamar al iniciar la app, idealmente
     * después del primer clic del usuario).
     */
    function preload() {
        _getAudioContext();
        _loadBuffer();
    }

    /**
     * Iniciar reproducción del ringback en loop.
     * Llamar cuando la llamada entra en estado "progress" / "ringing".
     */
    async function start() {
        if (isPlaying) {
            console.log('[Ringback] Ya está sonando, ignorando start()');
            return;
        }

        const ctx = _getAudioContext();
        if (!ctx) return;

        // Asegurar que el buffer esté cargado
        if (!audioBuffer) {
            console.log('[Ringback] Buffer no listo, cargando ahora...');
            await _loadBuffer();
            if (!audioBuffer) {
                console.error('[Ringback] No se pudo cargar el buffer');
                return;
            }
        }

        try {
            // Crear nueva fuente (las fuentes son de un solo uso)
            sourceNode = ctx.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.loop = true;

            // Nodo de ganancia para controlar volumen
            gainNode = ctx.createGain();
            gainNode.gain.value = 0.7; // 70% — no muy fuerte

            // Conectar: fuente -> ganancia -> salida
            sourceNode.connect(gainNode);
            gainNode.connect(ctx.destination);

            sourceNode.start(0);
            isPlaying = true;
            console.log('[Ringback] ▶ Sonando');

        } catch (err) {
            console.error('[Ringback] Error al iniciar:', err);
            isPlaying = false;
        }
    }

    /**
     * Detener el ringback.
     * Llamar cuando la llamada se contesta (confirmed), falla o se cuelga.
     */
    function stop() {
        if (!isPlaying) return;

        try {
            if (sourceNode) {
                // Fade-out suave de 80ms para evitar "click" de corte
                if (gainNode && audioCtx) {
                    const now = audioCtx.currentTime;
                    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
                    gainNode.gain.linearRampToValueAtTime(0, now + 0.08);
                    setTimeout(() => {
                        try {
                            sourceNode && sourceNode.stop(0);
                            sourceNode && sourceNode.disconnect();
                        } catch (e) { /* ya detenido */ }
                        sourceNode = null;
                        gainNode = null;
                    }, 100);
                } else {
                    sourceNode.stop(0);
                    sourceNode.disconnect();
                    sourceNode = null;
                    gainNode = null;
                }
            }
            isPlaying = false;
            console.log('[Ringback] ⏹ Detenido');

        } catch (err) {
            console.error('[Ringback] Error al detener:', err);
            isPlaying = false;
        }
    }

    /**
     * Saber si está sonando ahora mismo.
     */
    function playing() {
        return isPlaying;
    }

    // API pública
    return {
        preload: preload,
        start: start,
        stop: stop,
        playing: playing
    };
})();
