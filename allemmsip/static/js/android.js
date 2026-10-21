/* ========================================
   ALLEMM SIP - Adaptador Android
   ========================================
   En el APK, el motor SIP (PJSIP) vive en un servicio nativo y se expone a
   la página como window.AllemmAndroid (métodos síncronos que devuelven JSON).
   Este archivo lo presenta como window.pywebview.api — la misma forma que en
   escritorio — para que sip.js, settings.js y app.js funcionen sin cambios.

   En escritorio (pywebview) window.AllemmAndroid no existe y no hace nada.
   ======================================== */
(function () {
    'use strict';
    var A = window.AllemmAndroid;
    if (!A) return;

    var METHODS = ['app_info', 'get_settings', 'save_settings', 'list_audio_devices', 'engine_status',
        'get_launch_number', 'sip_register', 'sip_unregister', 'sip_reconnect', 'sip_network_changed',
        'sip_call', 'sip_answer', 'sip_hangup', 'sip_toggle_mute', 'sip_hold', 'sip_transfer', 'sip_dtmf',
        'open_log_folder', 'set_speaker', 'monitor_report'];

    function toArg(v) {
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    }

    var api = {};
    METHODS.forEach(function (name) {
        api[name] = function () {
            var args = Array.prototype.map.call(arguments, toArg);
            return new Promise(function (resolve, reject) {
                try {
                    var raw = A[name].apply(A, args);
                    resolve(raw === undefined || raw === null || raw === '' ? null : JSON.parse(raw));
                } catch (e) { reject(e); }
            });
        };
    });

    window.pywebview = { api: api, platform: 'android' };
    window.ALLEMM_ANDROID = true;

    document.addEventListener('DOMContentLoaded', function () {
        document.body.classList.add('is-android');

        if (typeof UvacApp !== 'undefined') {
            // El timbre lo toca el servicio nativo (suena aunque la app esté en segundo plano).
            UvacApp._playRingtone = function () {};
            // Altavoz: lo decide Android (AudioManager), no el <audio> del WebView.
            UvacApp._toggleSpeaker = function () {
                var btn = document.getElementById('speakerBtn');
                this.speakerActive = !this.speakerActive;
                api.set_speaker(this.speakerActive);
                if (btn) {
                    btn.classList.toggle('active', this.speakerActive);
                    btn.title = this.speakerActive ? 'Altavoz ACTIVO' : 'Activar altavoz';
                }
            };
            var origEnd = UvacApp._endActiveCall;
            UvacApp._endActiveCall = function () {
                if (this.speakerActive) api.set_speaker(false);
                return origEnd.apply(this, arguments);
            };
        }
        var rt = document.getElementById('ringtone');
        if (rt) { rt.removeAttribute('loop'); rt.muted = true; }

        window.dispatchEvent(new Event('pywebviewready'));
        setTimeout(resync, 300);
    });

    /**
     * Si la pantalla se recrea (Android la cerró en segundo plano) el servicio
     * puede seguir registrado o con una llamada: sincronizar la interfaz.
     */
    function resync() {
        api.engine_status().then(function (st) {
            if (!st || !st.registered || typeof UvacSIP === 'undefined') return;
            UvacSIP.savedExtension = st.extension;
            var lbl = document.getElementById('extensionLabel');
            if (lbl) lbl.textContent = 'Ext. ' + st.extension;
            window.AllemmBridge.dispatch({ name: 'registered', data: {} });
            if (!st.inCall) return;
            setTimeout(function () {
                if (st.incoming && !st.established) {
                    window.AllemmBridge.dispatch({ name: 'incoming_call', data: { caller: st.caller || '' } });
                } else {
                    UvacSIP.currentSession = new AllemmSession(st.incoming ? 'incoming' : 'outgoing');
                    if (typeof UvacApp !== 'undefined') {
                        UvacApp.currentCallNumber = st.caller || '';
                        UvacApp.isInCall = true;
                        UvacApp._showActiveCall(st.caller || '', st.incoming ? 'incoming' : 'outgoing');
                    }
                    if (st.established) window.AllemmBridge.dispatch({ name: 'call_answered', data: {} });
                }
            }, 1000);
        }).catch(function () {});
    }
})();
