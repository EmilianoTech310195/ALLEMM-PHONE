package com.allemm.sip

import android.content.Intent
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Lo que la interfaz llama como window.AllemmAndroid.<método>. El archivo
 * static/js/android.js lo envuelve como window.pywebview.api para que la
 * interfaz sea idéntica a la de escritorio (mismos nombres que bridge.py).
 * Todos los métodos devuelven JSON (texto) y nunca lanzan excepciones a JS.
 */
class JsBridge(private val activity: MainActivity) {

    private fun service(): SipService = SipService.ensureStarted(activity)

    private fun ok(v: Any?): String = when (v) {
        null -> "null"
        is Map<*, *> -> JSONObject(v).toString()
        is List<*> -> JSONArray(v).toString()
        is String -> JSONObject.quote(v)
        else -> v.toString()
    }

    private inline fun guard(default: Any?, block: () -> Any?): String = try {
        ok(block())
    } catch (t: Throwable) {
        Log.e("Operación desde la interfaz falló", t)
        activity.dispatch("engine_error", mapOf("message" to (t.message ?: t.javaClass.simpleName)))
        ok(default)
    }

    @JavascriptInterface fun app_info(): String = ok(mapOf(
        "name" to "ALLEMM SIP", "version" to BuildConfig.VERSION_NAME, "engineAvailable" to true,
        "engineError" to "", "dataDir" to activity.filesDir.absolutePath, "platform" to "android"))

    @JavascriptInterface fun get_settings(): String = Settings.load(activity).toString()

    @JavascriptInterface fun save_settings(json: String): String = guard(null) {
        val s = Settings.save(activity, JSONObject(json))
        SipService.instance?.applySettings(s)
        s
    }.let { if (it == "null") Settings.load(activity).toString() else it }

    @JavascriptInterface fun list_audio_devices(): String = "[]"   // Android elige auricular/altavoz/bluetooth

    @JavascriptInterface fun engine_status(): String = guard(mapOf("registered" to false)) {
        SipService.instance?.takeIf { it.engineReady.isDone }?.engine?.snapshot() ?: mapOf("registered" to false, "inCall" to false)
    }

    @JavascriptInterface fun get_launch_number(): String = ok(activity.takeLaunchNumber())

    @JavascriptInterface fun sip_register(ext: String, pass: String, server: String): String = guard(mapOf("ok" to false)) {
        if (server.isNotBlank()) {
            val cur = Settings.load(activity)
            val (host, port) = Settings.parseServer(server, cur.optInt("sipPort", 5060))
            if (host.isEmpty()) return@guard mapOf("ok" to false, "cause" to "BAD_SERVER", "error" to "Servidor SIP inválido")
            if (host != cur.optString("sipServer") || port != cur.optInt("sipPort")) {
                Settings.save(activity, JSONObject().put("sipServer", host).put("sipPort", port))
            }
        }
        val svc = service()
        svc.applySettings(Settings.load(activity))
        svc.engine.register(ext, pass)
        activity.requestBatteryExemptionOnce()
        mapOf("ok" to true)
    }

    @JavascriptInterface fun sip_unregister(): String = guard(false) {
        SipService.instance?.shutdown(); true
    }

    @JavascriptInterface fun sip_reconnect(): String = guard(false) { service().engine.reconnect(); true }
    @JavascriptInterface fun sip_network_changed(): String = guard(false) { service().engine.networkChanged(); true }

    @JavascriptInterface fun sip_call(number: String): String = guard(false) {
        val svc = service()
        val ok = svc.engine.makeCall(number)
        if (ok) svc.onOutgoingCall(number)
        ok
    }

    @JavascriptInterface fun sip_answer(): String = guard(false) { service().engine.answer() }
    @JavascriptInterface fun sip_hangup(): String = guard(false) { service().engine.hangup() }
    @JavascriptInterface fun sip_toggle_mute(): String = guard(false) { service().engine.toggleMute() }
    @JavascriptInterface fun sip_hold(on: String): String = guard(false) { service().engine.hold(on == "true") }
    @JavascriptInterface fun sip_transfer(number: String): String = guard(false) { service().engine.transfer(number) }
    @JavascriptInterface fun sip_dtmf(tone: String): String = guard(false) { service().engine.sendDtmf(tone) }

    @JavascriptInterface fun set_speaker(on: String): String = guard(false) {
        val want = on == "true"
        activity.runOnUiThread { SipService.instance?.setSpeaker(want) }
        want
    }

    /** "Logs" en Ajustes: compartir allemmsip.log (correo, WhatsApp, Drive…). */
    @JavascriptInterface fun open_log_folder(): String = guard(false) {
        val f = File(activity.filesDir, "allemmsip.log")
        if (!f.exists()) f.writeText("")
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, "allemmsip.log")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.runOnUiThread { activity.startActivity(Intent.createChooser(send, "Compartir log")) }
        true
    }
}
