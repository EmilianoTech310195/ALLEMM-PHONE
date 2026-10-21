package com.allemm.sip

import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Log a archivo (allemmsip.log en la carpeta privada de la app), con el mismo
 * formato que la versión de escritorio. Se puede compartir desde Ajustes → Logs.
 * Sin dependencias de Android para poder probar el motor fuera del teléfono.
 */
object Log {
    @Volatile var file: File? = null
    @Volatile var debug = false
    private val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss,SSS", Locale.US)
    private const val MAX_BYTES = 2_000_000L

    @Synchronized
    private fun write(level: String, tag: String, msg: String, t: Throwable? = null) {
        val line = "${fmt.format(Date())} $level $tag: $msg" + (t?.let { "\n" + it.stackTraceToString() } ?: "")
        try { android.util.Log.println(if (level == "ERROR") 6 else 4, "AllemmSIP", line) } catch (_: Throwable) { println(line) }
        val f = file ?: return
        try {
            if (f.length() > MAX_BYTES) {
                val old = File(f.parentFile, f.name + ".1")
                old.delete(); f.renameTo(old)
            }
            FileWriter(f, true).use { it.write(line + "\n") }
        } catch (_: Throwable) {}
    }

    fun i(msg: String) = write("INFO", "allemmsip.engine", msg)
    fun w(msg: String) = write("WARNING", "allemmsip.engine", msg)
    fun e(msg: String, t: Throwable? = null) = write("ERROR", "allemmsip.engine", msg + (t?.message?.let { ": $it" } ?: ""), if (debug) t else null)
    fun app(msg: String) = write("INFO", "allemmsip.android", msg)
    fun pjsip(level: String, msg: String) {
        if (level == "I" && !debug) return
        write(if (level == "E") "ERROR" else if (level == "W") "WARNING" else "INFO", "pjsip", msg.trimEnd())
    }
}
