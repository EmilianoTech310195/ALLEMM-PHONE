package com.allemm.sip

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Configuración persistente (SharedPreferences), con las MISMAS claves que el
 * settings.json de escritorio (allemmsip/config.py) para que la interfaz
 * compartida funcione igual. Diferencias de celular: registro cada 120 s y
 * "keepAwake" para mantener la extensión viva con la pantalla apagada.
 */
object Settings {
    private const val PREFS = "allemmsip"
    private const val KEY = "settings"

    val DEFAULTS: JSONObject get() = JSONObject().apply {
        put("sipServer", "pbx18879.pbxhosting.com.mx")
        put("sipPort", 49999)
        put("transport", "udp")
        put("autoTransportFallback", true)
        put("registerExpires", 120)          // celular: registro corto, se recupera rápido
        put("registerTimeout", 15)
        put("retryDelay", 5)
        put("maxRetries", 3)
        put("stunEnabled", false)
        put("stunServers", JSONArray(listOf("stun.l.google.com:19302", "stun1.l.google.com:19302")))
        put("srtp", "off")
        put("sessionTimers", false)
        put("captureDevice", "")
        put("playbackDevice", "")
        put("echoCancelMs", 200)
        put("audioCodecs", JSONArray(listOf("PCMU", "PCMA", "G722", "opus")))
        put("dtmfMode", "INFO")
        put("appName", "ALLEMM")
        put("companyName", "ALLEMM")
        put("tagline", "Tecnología que opera contigo")
        put("footerText", "Ingresa tus credenciales SIP")
        put("historyRetentionDays", 6)
        put("callTimeout", 60)
        put("autoDial", true)
        put("startMinimized", false)
        put("monitorUrl", "")
        put("monitorToken", "")
        put("debug", false)
        put("pjsipLogLevel", 3)
        put("keepAwake", true)               // Android: wake lock mientras está registrado
    }

    fun load(ctx: Context): JSONObject {
        val out = DEFAULTS
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return out
        try {
            val saved = JSONObject(raw)
            for (k in saved.keys()) if (out.has(k)) out.put(k, saved.get(k))
        } catch (_: Exception) {}
        return out
    }

    fun save(ctx: Context, values: JSONObject): JSONObject {
        val merged = load(ctx)
        for (k in values.keys()) if (merged.has(k)) merged.put(k, values.get(k))
        normalize(merged)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, merged.toString()).apply()
        return merged
    }

    private fun normalize(s: JSONObject) {
        s.put("sipServer", s.optString("sipServer").trim())
        s.put("sipPort", s.optString("sipPort").toIntOrNull()?.takeIf { it in 1..65535 } ?: 5060)
        val t = s.optString("transport").lowercase()
        s.put("transport", if (t in listOf("udp", "tcp", "tls")) t else "udp")
        s.put("dtmfMode", if (s.optString("dtmfMode").equals("RFC2833", true)) "RFC2833" else "INFO")
        if (s.optString("srtp") !in listOf("off", "optional", "mandatory")) s.put("srtp", "off")
        for (k in listOf("registerExpires", "registerTimeout", "retryDelay", "maxRetries", "echoCancelMs",
                         "historyRetentionDays", "callTimeout", "pjsipLogLevel")) {
            s.put(k, s.optString(k).toIntOrNull() ?: DEFAULTS.getInt(k))
        }
    }

    fun toEngine(s: JSONObject) = SipEngine.EngineSettings(
        sipServer = s.optString("sipServer"),
        sipPort = s.optInt("sipPort", 5060),
        transport = s.optString("transport", "udp"),
        registerExpires = s.optInt("registerExpires", 120),
        retryDelay = s.optInt("retryDelay", 5),
        registerTimeout = s.optInt("registerTimeout", 15),
        stunServers = if (s.optBoolean("stunEnabled")) s.optJSONArray("stunServers").toList() else emptyList(),
        codecs = s.optJSONArray("audioCodecs").toList().ifEmpty { listOf("PCMU", "PCMA") },
        dtmfMode = s.optString("dtmfMode", "INFO"),
        srtp = s.optString("srtp", "off"),
        echoCancelMs = s.optInt("echoCancelMs", 200),
        userAgent = "ALLEMM SIP Android/${BuildConfig.VERSION_NAME}",
        logLevel = if (s.optBoolean("debug")) 5 else s.optInt("pjsipLogLevel", 3),
        sessionTimers = s.optBoolean("sessionTimers"),
        autoFallbackTcp = s.optBoolean("autoTransportFallback", true),
    )

    private fun JSONArray?.toList(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotBlank() }

    /** "pbx.midominio.com:49999" → ("pbx.midominio.com", 49999); igual que config.parse_server. */
    fun parseServer(text: String, defaultPort: Int = 5060): Pair<String, Int> {
        var t = text.trim()
        for (p in listOf("sip:", "sips:")) if (t.lowercase().startsWith(p)) t = t.substring(p.length)
        t = t.substringBefore('/').substringBefore(';').trim()
        if (t.isEmpty()) return "" to defaultPort
        val host: String
        val port: String
        when {
            t.startsWith("[") -> { host = t.substring(1).substringBefore(']'); port = t.substringAfter(']', "").trimStart(':') }
            t.count { it == ':' } == 1 -> { host = t.substringBefore(':'); port = t.substringAfter(':') }
            else -> { host = t; port = "" }
        }
        val n = port.toIntOrNull()?.takeIf { it in 1..65535 } ?: defaultPort
        return host.trim() to n
    }
}
