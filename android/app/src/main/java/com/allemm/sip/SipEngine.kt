package com.allemm.sip

import org.pjsip.pjsua2.Account
import org.pjsip.pjsua2.AccountConfig
import org.pjsip.pjsua2.AuthCredInfo
import org.pjsip.pjsua2.Call
import org.pjsip.pjsua2.CallOpParam
import org.pjsip.pjsua2.CallSendDtmfParam
import org.pjsip.pjsua2.Endpoint
import org.pjsip.pjsua2.EpConfig
import org.pjsip.pjsua2.IpChangeParam
import org.pjsip.pjsua2.LogEntry
import org.pjsip.pjsua2.LogWriter
import org.pjsip.pjsua2.OnCallMediaStateParam
import org.pjsip.pjsua2.OnCallStateParam
import org.pjsip.pjsua2.OnCallTransferStatusParam
import org.pjsip.pjsua2.OnIncomingCallParam
import org.pjsip.pjsua2.OnRegStateParam
import org.pjsip.pjsua2.StringVector
import org.pjsip.pjsua2.TransportConfig
import org.pjsip.pjsua2.pjmedia_srtp_use
import org.pjsip.pjsua2.pjmedia_type
import org.pjsip.pjsua2.pjsip_event_id_e
import org.pjsip.pjsua2.pjsip_inv_state
import org.pjsip.pjsua2.pjsip_status_code
import org.pjsip.pjsua2.pjsip_transport_type_e
import org.pjsip.pjsua2.pjsua_call_flag
import org.pjsip.pjsua2.pjsua_call_media_status
import org.pjsip.pjsua2.pjsua_dtmf_method
import org.pjsip.pjsua2.pjsua_sip_timer_use
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Motor SIP sobre PJSIP (pjsua2) — versión Android del allemmsip/engine.py de escritorio.
 *
 * Todo pjsua2 vive en UN hilo propio ("sip-engine"): ahí se crea la librería, se
 * procesan los eventos (threadCnt = 0 + libHandleEvents) y se ejecutan los
 * trabajos que llegan desde la interfaz. Así los callbacks de PJSIP también
 * corren en ese hilo y no hay que registrar hilos ni sincronizar.
 *
 * Los nombres de eventos y causas son los mismos que en escritorio (estilo
 * JsSIP), para que la interfaz compartida (allemmsip/static) no cambie.
 */
class SipEngine(@Volatile var settings: EngineSettings, private val listener: (String, Map<String, Any?>) -> Unit) {

    data class EngineSettings(
        var sipServer: String = "",
        var sipPort: Int = 5060,
        var transport: String = "udp",
        var registerExpires: Int = 300,
        var retryDelay: Int = 5,
        var registerTimeout: Int = 15,
        var stunServers: List<String> = emptyList(),
        var codecs: List<String> = listOf("PCMU", "PCMA", "G722", "opus"),
        var dtmfMode: String = "INFO",
        var srtp: String = "off",
        var echoCancelMs: Int = 200,
        var userAgent: String = "ALLEMM SIP Android/1.0",
        var logLevel: Int = 3,
        var sessionTimers: Boolean = false,
        var autoFallbackTcp: Boolean = true,
        var displayName: String = "",
        var authUser: String = "",
        var outboundProxy: String = "",
        var tlsVerify: Boolean = false,
    )

    // ---------------------------------------------------------------- hilo
    private val jobs = LinkedBlockingQueue<Runnable>()
    @Volatile private var running = false
    private var thread: Thread? = null

    private var ep: Endpoint? = null
    private var logWriter: Writer? = null
    private var acc: Acc? = null
    private var call: SipCall? = null
    private val deadCalls = mutableListOf<SipCall>()
    private val transports = mutableMapOf<String, Boolean>()

    @Volatile var isRegistered = false; private set
    @Volatile var extension = ""; private set
    @Volatile var muted = false; private set
    @Volatile var onHold = false; private set
    private var password = ""
    private var regDeadline = 0L
    private var fallbackDone = false
    private var lastAuthFailure = 0L
    private var engineVersion = ""

    val inCall: Boolean get() = call != null
    val callEstablished: Boolean get() = call?.confirmed == true

    private fun emit(name: String, data: Map<String, Any?> = emptyMap()) {
        try { listener(name, data) } catch (t: Throwable) { Log.e("Listener falló en $name", t) }
    }

    /** Ejecuta en el hilo del motor y espera el resultado. */
    private fun <T> run(timeoutSec: Long = 15, block: () -> T): T {
        if (Thread.currentThread() === thread) return block()
        check(running) { "El motor SIP no está iniciado" }
        val f = CompletableFuture<T>()
        jobs.put(Runnable { try { f.complete(block()) } catch (t: Throwable) { f.completeExceptionally(t) } })
        return f.get(timeoutSec, TimeUnit.SECONDS)
    }

    private fun post(block: () -> Unit) { jobs.put(Runnable { try { block() } catch (t: Throwable) { Log.e("Trabajo del motor falló", t) } }) }

    fun start() {
        if (running) return
        running = true
        val ready = CompletableFuture<Unit>()
        thread = Thread({
            try {
                libStart()
                ready.complete(Unit)
            } catch (t: Throwable) {
                Log.e("No se pudo iniciar PJSIP", t)
                running = false
                ready.completeExceptionally(t)
                libStop()
                return@Thread
            }
            loop()
            libStop()
        }, "sip-engine").also { it.start() }
        ready.get(30, TimeUnit.SECONDS)
    }

    fun stop() {
        if (!running) return
        try { run(10) { unregisterJob() } } catch (_: Throwable) {}
        running = false
        thread?.join(15_000)
        thread = null
    }

    private fun loop() {
        while (running) {
            var job = jobs.poll()
            while (job != null) {
                job.run()
                job = jobs.poll()
            }
            try { ep?.libHandleEvents(20) } catch (t: Throwable) { Log.e("libHandleEvents", t) }
            checkRegisterTimeout()
        }
    }

    // ------------------------------------------------------- ciclo de vida
    private fun libStart() {
        val s = settings
        val e = Endpoint()
        ep = e
        e.libCreate()
        val cfg = EpConfig()
        cfg.uaConfig.userAgent = s.userAgent
        cfg.uaConfig.maxCalls = 4
        cfg.uaConfig.threadCnt = 0          // los eventos se procesan en nuestro hilo
        cfg.uaConfig.mainThreadOnly = false
        if (s.stunServers.isNotEmpty()) {
            val v = StringVector()
            s.stunServers.forEach { v.add(it) }
            cfg.uaConfig.stunServer = v
            cfg.uaConfig.stunIgnoreFailure = true
        }
        cfg.logConfig.level = s.logLevel.toLong()
        cfg.logConfig.consoleLevel = 0
        cfg.logConfig.msgLogging = if (s.logLevel >= 5) 1 else 0
        logWriter = Writer()
        cfg.logConfig.writer = logWriter
        cfg.medConfig.ecTailLen = s.echoCancelMs.toLong()
        cfg.medConfig.noVad = true
        e.libInit(cfg)

        // UDP, TCP y TLS: el registrador elige por la URI (";transport=tcp").
        transports.clear()
        for ((name, kind) in listOf(
            "udp" to pjsip_transport_type_e.PJSIP_TRANSPORT_UDP,
            "tcp" to pjsip_transport_type_e.PJSIP_TRANSPORT_TCP,
            "tls" to pjsip_transport_type_e.PJSIP_TRANSPORT_TLS,
        )) {
            val t = TransportConfig()
            t.port = 0
            if (name == "tls") t.tlsConfig.verifyServer = s.tlsVerify
            try {
                e.transportCreate(kind, t)
                transports[name] = true
            } catch (ex: Exception) {
                transports[name] = false
                Log.w("Transporte ${name.uppercase()} no disponible: ${ex.message}")
            }
        }
        if (transports[s.transport.lowercase()] != true) {
            Log.w("El transporte ${s.transport.uppercase()} no está disponible en esta versión; se usa UDP")
            s.transport = "udp"
        }
        e.libStart()
        applyCodecs()
        engineVersion = e.libVersion().full
        Log.i("PJSIP $engineVersion iniciado (${s.transport.uppercase()})")
    }

    private fun libStop() {
        try {
            call?.let { hangupCall(it, 0) }
            call = null
            destroyDeadCalls(force = true)
            acc?.let { try { it.shutdown() } catch (_: Exception) {}; it.delete() }
            acc = null
            ep?.libDestroy()
            ep?.delete()
        } catch (t: Throwable) {
            Log.e("Error al apagar PJSIP", t)
        } finally {
            ep = null
        }
    }

    private fun applyCodecs() {
        val e = ep ?: return
        val wanted = settings.codecs.map { it.lowercase() }
        for (info in e.codecEnum2()) {
            val name = info.codecId.substringBefore('/').lowercase()
            val idx = wanted.indexOf(name)
            val prio = if (idx >= 0) 255 - idx else 0
            try { e.codecSetPriority(info.codecId, prio.toShort()) } catch (_: Exception) {}
        }
    }

    // ------------------------------------------------------------ registro
    private fun domain(): String {
        val s = settings
        val def = if (s.transport.equals("tls", true)) 5061 else 5060
        val port = if (s.sipPort != 0 && s.sipPort != def) ":${s.sipPort}" else ""
        return s.sipServer.trim() + port
    }

    private fun serverUri(): String {
        val t = settings.transport.lowercase()
        return "sip:${domain()}" + (if (t == "udp") "" else ";transport=$t")
    }

    fun register(ext: String, pass: String) {
        extension = ext.trim()
        password = pass
        fallbackDone = false
        run { registerJob() }
    }

    fun reconnect() { if (extension.isNotEmpty()) { fallbackDone = false; run { registerJob() } } }

    val hasCredentials: Boolean get() = extension.isNotEmpty() && password.isNotEmpty()

    fun availableTransports(): Map<String, Boolean> =
        if (transports.isEmpty()) mapOf("udp" to true, "tcp" to true, "tls" to false) else HashMap(transports)

    /**
     * Aplica ajustes nuevos. restart: rearma PJSIP (STUN, TLS, logs, códecs);
     * reregister: rehace la cuenta. "busy" si hay llamada (se aplica después).
     */
    fun reconfigure(newSettings: EngineSettings, restart: Boolean, reregister: Boolean): String {
        if ((restart || reregister) && inCall) { settings = newSettings; return "busy" }
        val had = hasCredentials
        settings = newSettings
        if (restart && running) {
            val ext = extension; val pw = password
            stop(); start()
            if (had) register(ext, pw)
            return "restarted"
        }
        if (reregister && had && running) { reconnect(); return "reregistered" }
        return "saved"
    }

    /** Desregistrar sin olvidar las credenciales (p. ej. sin WiFi y con datos móviles desactivados). */
    fun pause() { if (running) run { unregisterJob() } }

    fun unregister() { run { unregisterJob() } }

    private fun registerJob() {
        destroyAccount()
        val s = settings
        if (s.sipServer.isBlank()) {
            emit("registration_failed", mapOf("cause" to "Connection Error", "code" to 0, "reason" to "No hay servidor SIP configurado"))
            return
        }
        val cfg = AccountConfig()
        cfg.idUri = accountIdUri(extension, domain(), s.displayName)
        cfg.regConfig.registrarUri = serverUri()
        cfg.regConfig.registerOnAdd = true
        cfg.regConfig.timeoutSec = s.registerExpires.toLong()
        cfg.regConfig.retryIntervalSec = s.retryDelay.toLong()
        cfg.regConfig.firstRetryIntervalSec = maxOf(1, s.retryDelay / 2).toLong()
        cfg.regConfig.randomRetryIntervalSec = 2
        cfg.regConfig.dropCallsOnFail = false
        val authUser = s.authUser.trim().ifEmpty { extension }
        cfg.sipConfig.authCreds.add(AuthCredInfo("digest", "*", authUser, 0, password))
        val route = proxyRoute(s.outboundProxy, s.transport, serverUri())
        if (route.isNotEmpty()) cfg.sipConfig.proxies.add(route)
        cfg.natConfig.contactRewriteUse = 1
        cfg.natConfig.viaRewriteUse = 1
        cfg.natConfig.sdpNatRewriteUse = 1
        cfg.natConfig.udpKaIntervalSec = if (s.transport.equals("udp", true)) 15 else 0
        cfg.mediaConfig.srtpUse = when (s.srtp) {
            "mandatory" -> pjmedia_srtp_use.PJMEDIA_SRTP_MANDATORY
            "optional" -> pjmedia_srtp_use.PJMEDIA_SRTP_OPTIONAL
            else -> pjmedia_srtp_use.PJMEDIA_SRTP_DISABLED
        }
        cfg.mediaConfig.srtpSecureSignaling = 0
        cfg.callConfig.timerUse = if (s.sessionTimers) pjsua_sip_timer_use.PJSUA_SIP_TIMER_OPTIONAL
                                  else pjsua_sip_timer_use.PJSUA_SIP_TIMER_INACTIVE
        val a = Acc()
        a.create(cfg, true)
        acc = a
        emit("health", mapOf("state" to "warning"))
        regDeadline = System.currentTimeMillis() + s.registerTimeout * 1000L
    }

    private fun unregisterJob() {
        destroyAccount()
        emit("health", mapOf("state" to "offline"))
    }

    private fun destroyAccount() {
        regDeadline = 0
        call?.let { hangupCall(it, 0) }
        call = null
        acc?.let { try { it.shutdown() } catch (_: Exception) {}; it.delete() }
        acc = null
        isRegistered = false
    }

    private fun checkRegisterTimeout() {
        if (regDeadline == 0L || isRegistered || System.currentTimeMillis() < regDeadline) return
        regDeadline = 0
        onRegisterTimeout()
    }

    private fun onRegisterTimeout() {
        if (isRegistered) return
        val secs = settings.registerTimeout
        if (canFallbackToTcp()) {
            Log.w("UDP sin respuesta en ${secs}s: reintentando por TCP")
            settings.transport = "tcp"
            fallbackDone = true
            emit("health", mapOf("state" to "warning"))
            emit("transport_fallback", mapOf("from" to "udp", "to" to "tcp"))
            post { registerJob() }
            return
        }
        revertFailedFallback()
        emit("health", mapOf("state" to "error"))
        val data = mutableMapOf<String, Any?>("cause" to "Connection Timeout", "code" to 0, "reason" to "Sin respuesta del PBX en ${secs}s")
        if (recentAuthFailure()) data["hint"] = "auth_ban"
        emit("registration_failed", data)
    }

    /** TCP tampoco funcionó: el siguiente intento vuelve a UDP (lo configurado). */
    private fun revertFailedFallback() {
        if (fallbackDone && settings.transport.equals("tcp", true)) {
            Log.i("TCP tampoco respondió; se vuelve a UDP para el siguiente intento")
            settings.transport = "udp"
        }
    }

    private fun canFallbackToTcp() = settings.autoFallbackTcp && settings.transport.equals("udp", true) &&
        !fallbackDone && transports["tcp"] == true

    private fun recentAuthFailure() = lastAuthFailure != 0L && System.currentTimeMillis() - lastAuthFailure < 30 * 60_000L

    private fun onRegState(code: Int, reason: String, expiration: Long, status: Int) {
        Log.i("REGISTER → $code $reason (exp=$expiration status=$status)")
        if (code == 200 && expiration > 0 && status == 0) {
            regDeadline = 0
            isRegistered = true
            if (fallbackDone && settings.transport.equals("tcp", true)) {
                emit("transport_saved", mapOf("transport" to "tcp"))   // registró por TCP: recordarlo
                fallbackDone = false
            }
            emit("health", mapOf("state" to "ok"))
            emit("registered")
            return
        }
        if (code == 200 && expiration == 0L) {
            isRegistered = false
            emit("health", mapOf("state" to "offline"))
            emit("unregistered")
            return
        }
        val was = isRegistered
        isRegistered = false
        regDeadline = 0
        revertFailedFallback()
        val cause = registrationCause(code, reason, status)
        val data = mutableMapOf<String, Any?>("cause" to cause, "code" to code, "reason" to reason)
        if (cause == "Authentication Error" || cause == "Forbidden") lastAuthFailure = System.currentTimeMillis()
        else if (recentAuthFailure()) data["hint"] = "auth_ban"
        emit("health", mapOf("state" to "error"))
        if (was) emit("unregistered")
        emit("registration_failed", data)
    }

    /** Sin tarjeta de sonido (pruebas automáticas). */
    fun useNullAudio() = run { ep!!.audDevManager().setNullDev() }

    /** Cuenta sin registro, para llamadas directas IP a IP (pruebas). */
    fun addLocalAccount(user: String) = run {
        destroyAccount()
        val cfg = AccountConfig()
        cfg.idUri = "sip:$user@127.0.0.1"
        cfg.regConfig.registerOnAdd = false
        cfg.mediaConfig.srtpUse = pjmedia_srtp_use.PJMEDIA_SRTP_DISABLED
        val a = Acc(); a.create(cfg, true); acc = a
        isRegistered = true
    }

    /** Puerto local del transporte UDP (pruebas). */
    fun localPort(): Int = run {
        val e = ep!!
        Regex(":(\\d+)$").find(e.transportGetInfo(e.transportEnum()[0]).localName)?.groupValues?.get(1)?.toInt() ?: 0
    }

    fun networkChanged() {
        if (!running) return
        post {
            val e = ep ?: return@post
            val p = IpChangeParam()
            p.restartListener = true
            p.restartLisDelay = 500
            e.handleIpChange(p)
        }
    }

    // ------------------------------------------------------------- llamadas
    fun makeCall(number: String): Boolean {
        var n = number.trim()
        if (!n.startsWith("sip:") && !n.startsWith("sips:")) n = n.replace(Regex("[^\\d*#+]"), "")
        if (n.isEmpty()) return false
        return run {
            val a = acc
            if (a == null || !isRegistered || call != null) return@run false
            val target = if (n.startsWith("sip")) n else "sip:$n@${domain()}"
            val c = SipCall(a, -1, incoming = false)
            c.remoteUser = uriUser(target)
            val prm = CallOpParam(true)
            prm.opt.audioCount = 1
            prm.opt.videoCount = 0
            call = c
            muted = false; onHold = false
            try {
                c.makeCall(target, prm)
                Log.i("Llamando a $target")
                true
            } catch (ex: Exception) {
                Log.e("makeCall falló", ex)
                call = null
                deadCalls.add(c)
                false
            }
        }
    }

    fun answer(): Boolean = run {
        val c = call ?: return@run false
        if (!c.incoming || c.confirmed) return@run false
        val prm = CallOpParam()
        prm.statusCode = pjsip_status_code.PJSIP_SC_OK
        prm.opt.audioCount = 1
        prm.opt.videoCount = 0
        c.answer(prm)
        true
    }

    fun hangup(): Boolean = run {
        val c = call ?: return@run false
        c.localHangup = true
        hangupCall(c, if (c.incoming && !c.confirmed) pjsip_status_code.PJSIP_SC_DECLINE else 0)
        true
    }

    private fun hangupCall(c: SipCall, code: Int) {
        try {
            val prm = CallOpParam()
            if (code != 0) prm.statusCode = code
            c.hangup(prm)
        } catch (_: Exception) { /* ya terminó */ }
    }

    fun toggleMute(): Boolean = run { muted = !muted; applyMute(); muted }

    private fun applyMute() {
        val c = call ?: return
        if (!c.confirmed) return
        try {
            val am = c.getAudioMedia(-1)
            val cap = ep!!.audDevManager().captureDevMedia
            if (muted) cap.stopTransmit(am) else cap.startTransmit(am)
        } catch (ex: Exception) { Log.e("No se pudo cambiar el mute", ex) }
    }

    fun hold(on: Boolean): Boolean = run {
        val c = call ?: return@run false
        if (!c.confirmed) return@run false
        val prm = CallOpParam(true)
        if (on) c.setHold(prm) else {
            prm.opt.flag = prm.opt.flag or pjsua_call_flag.PJSUA_CALL_UNHOLD.toLong()
            c.reinvite(prm)
        }
        onHold = on
        true
    }

    fun transfer(number: String): Boolean {
        val n = number.replace(Regex("[^\\d*#+]"), "")
        return run {
            val c = call ?: return@run false
            if (!c.confirmed || n.isEmpty()) return@run false
            c.xfer("sip:$n@${domain()}", CallOpParam())
            true
        }
    }

    fun sendDtmf(tone: String): Boolean {
        val t = tone.replace(Regex("[^0-9A-Da-d*#]"), "")
        return run {
            val c = call ?: return@run false
            if (!c.confirmed || t.isEmpty()) return@run false
            val prm = CallSendDtmfParam()
            prm.method = if (settings.dtmfMode.equals("INFO", true)) pjsua_dtmf_method.PJSUA_DTMF_METHOD_SIP_INFO
                         else pjsua_dtmf_method.PJSUA_DTMF_METHOD_RFC2833
            prm.duration = 160
            prm.digits = t
            c.sendDtmf(prm)
            true
        }
    }

    // --------------------------------------------------- callbacks (hilo motor)
    private fun onIncomingCall(callId: Int) {
        val a = acc ?: return
        val c = SipCall(a, callId, incoming = true)
        val remote = try { c.info.remoteUri } catch (_: Exception) { "" }
        val caller = uriUser(remote)
        c.remoteUser = caller
        if (call != null) {
            Log.i("Ocupado: segunda llamada de $caller rechazada con 486")
            c.silent = true
            deadCalls.add(c)
            hangupCall(c, pjsip_status_code.PJSIP_SC_BUSY_HERE)
            return
        }
        call = c
        muted = false; onHold = false
        try {
            val prm = CallOpParam()
            prm.statusCode = pjsip_status_code.PJSIP_SC_RINGING
            c.answer(prm)
        } catch (ex: Exception) { Log.e("No se pudo enviar 180 Ringing", ex) }
        Log.i("Llamada entrante de $caller")
        emit("incoming_call", mapOf("caller" to caller, "display" to uriDisplay(remote)))
    }

    private fun onCallState(c: SipCall) {
        val ci = try { c.info } catch (_: Exception) { return }
        val state = ci.state
        if (c.silent) {
            if (state == pjsip_inv_state.PJSIP_INV_STATE_DISCONNECTED) post { destroyDeadCalls() }
            return
        }
        when (state) {
            pjsip_inv_state.PJSIP_INV_STATE_EARLY -> if (!c.incoming) emit("call_progress")
            pjsip_inv_state.PJSIP_INV_STATE_CONFIRMED -> if (!c.confirmed) { c.confirmed = true; emit("call_answered") }
            pjsip_inv_state.PJSIP_INV_STATE_DISCONNECTED -> {
                val code = ci.lastStatusCode
                if (call === c) call = null
                deadCalls.add(c)
                post { destroyDeadCalls() }
                if (c.confirmed) {
                    Log.i("Llamada terminada ($code)")
                    emit("call_ended", mapOf("code" to code))
                } else {
                    val cause = callFailureCause(code, c.localHangup, c.incoming)
                    val taken = takenByColleague(code, c.lastRawMessage, c.incoming, c.localHangup)
                    Log.i("Llamada no establecida: $cause ($code) compañero=$taken")
                    emit("call_failed", mapOf("cause" to cause, "code" to code, "taken_by_colleague" to taken))
                }
            }
        }
    }

    private fun destroyDeadCalls(force: Boolean = false) {
        val it = deadCalls.iterator()
        while (it.hasNext()) {
            val c = it.next()
            val active = try { c.isActive } catch (_: Exception) { false }
            if (!active || force) { try { c.delete() } catch (_: Exception) {}; it.remove() }
        }
    }

    private fun onCallMediaState(c: SipCall) {
        try {
            val e = ep ?: return
            val ci = c.info
            for (i in 0 until ci.media.size) {
                val mi = ci.media[i]
                if (mi.type != pjmedia_type.PJMEDIA_TYPE_AUDIO) continue
                if (mi.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_ACTIVE ||
                    mi.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_REMOTE_HOLD) {
                    val am = c.getAudioMedia(mi.index.toInt())
                    val adm = e.audDevManager()
                    am.startTransmit(adm.playbackDevMedia)
                    if (!muted) adm.captureDevMedia.startTransmit(am)
                    emit("media_active")
                }
            }
        } catch (ex: Exception) { Log.e("No se pudo conectar el audio", ex) }
    }

    /** Estado para la interfaz. Se llama desde otros hilos: solo lee campos Kotlin, nunca pjsua2. */
    fun snapshot(): Map<String, Any?> {
        val c = call
        return mapOf(
            "registered" to isRegistered,
            "extension" to extension,
            "inCall" to (c != null),
            "established" to (c?.confirmed == true),
            "incoming" to (c?.incoming == true),
            "caller" to (c?.remoteUser ?: ""),
            "muted" to muted,
            "onHold" to onHold,
            "server" to settings.sipServer,
            "transport" to settings.transport,
            "engine" to "pjsua2 $engineVersion",
        )
    }

    // ------------------------------------------------------- clases pjsua2
    private inner class Writer : LogWriter() {
        override fun write(entry: LogEntry) {
            when (entry.level) {
                0, 1 -> Log.pjsip("E", entry.msg)
                2 -> Log.pjsip("W", entry.msg)
                else -> Log.pjsip("I", entry.msg)
            }
        }
    }

    private inner class Acc : Account() {
        override fun onRegState(prm: OnRegStateParam) =
            this@SipEngine.onRegState(prm.code, prm.reason, prm.expiration, prm.status)

        override fun onIncomingCall(prm: OnIncomingCallParam) = this@SipEngine.onIncomingCall(prm.callId)
    }

    private inner class SipCall(a: Account, id: Int, val incoming: Boolean) : Call(a, id) {
        var confirmed = false
        var localHangup = false
        var silent = false
        var lastRawMessage = ""
        /** Se fija al crear la llamada (en el hilo del motor): snapshot() no debe tocar pjlib. */
        @Volatile var remoteUser: String = ""

        override fun onCallState(prm: OnCallStateParam) {
            try {
                val e = prm.e
                if (e.type == pjsip_event_id_e.PJSIP_EVENT_TSX_STATE &&
                    e.body.tsxState.type == pjsip_event_id_e.PJSIP_EVENT_RX_MSG) {
                    val raw = e.body.tsxState.src.rdata.wholeMsg
                    if (!raw.isNullOrEmpty()) lastRawMessage = raw
                }
            } catch (_: Exception) {}
            this@SipEngine.onCallState(this)
        }

        override fun onCallMediaState(prm: OnCallMediaStateParam) = this@SipEngine.onCallMediaState(this)

        override fun onCallTransferStatus(prm: OnCallTransferStatusParam) {
            emit("transfer_status", mapOf("code" to prm.statusCode, "reason" to prm.reason, "final" to prm.finalNotify))
            if (prm.finalNotify && prm.statusCode in 200..299) post { hangupCall(this, 0) }
        }
    }

    // --------------------------------------------- utilidades (como en Python)
    companion object {
        private val URI_USER = Regex("sips?:([^@;>]+)")
        private val DISPLAY = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<")
        private val ELSEWHERE = Regex("completed elsewhere|answered elsewhere|cause=200", RegexOption.IGNORE_CASE)

        fun accountIdUri(ext: String, domain: String, displayName: String): String {
            val name = displayName.replace("\"", "").replace("\\", "").trim()
            val uri = "sip:$ext@$domain"
            return if (name.isEmpty()) uri else "\"$name\" <$uri>"
        }

        fun proxyRoute(outboundProxy: String, transport: String, serverUri: String): String {
            val t = transport.lowercase()
            var p = outboundProxy.trim()
            if (p.isNotEmpty()) {
                if (!p.lowercase().startsWith("sip:") && !p.lowercase().startsWith("sips:")) p = "sip:$p"
                if (t != "udp" && !p.lowercase().contains(";transport=")) p += ";transport=$t"
                return "$p;lr"
            }
            return if (t == "udp") "" else "$serverUri;lr"
        }

        fun uriUser(uri: String?): String = URI_USER.find(uri ?: "")?.groupValues?.get(1) ?: (uri ?: "").trim()
        fun uriDisplay(uri: String?): String = DISPLAY.find(uri ?: "")?.groupValues?.get(1)?.trim() ?: ""

        fun registrationCause(code: Int, reason: String?, status: Int): String {
            val r = (reason ?: "").lowercase()
            return when {
                code == 401 || code == 407 -> "Authentication Error"
                code == 403 -> "Forbidden"
                code == 408 || "timed out" in r || "timeout" in r -> "Request Timeout"
                code == 500 -> "Internal Server Error"
                code == 503 && ("resolve" in r || "transport" in r || "unable" in r || status != 0) -> "Connection Error"
                code == 503 -> "Service Unavailable"
                code == 404 -> "Not Found"
                code == 0 || status != 0 -> "Connection Error"
                else -> "$code $reason".trim()
            }
        }

        fun callFailureCause(code: Int, localHangup: Boolean, incoming: Boolean): String {
            if (localHangup) return if (incoming) "Rejected" else "Canceled"
            return when (code) {
                404 -> "Not Found"; 408 -> "Request Timeout"; 410, 480 -> "Unavailable"
                486, 600 -> "Busy"; 487 -> "Canceled"; 500 -> "Internal Server Error"
                503 -> "Service Unavailable"; 603 -> "Rejected"
                else -> if (code >= 400) "Rejected" else "Canceled"
            }
        }

        fun takenByColleague(code: Int, raw: String?, incoming: Boolean, localHangup: Boolean): Boolean {
            if (!incoming || localHangup) return false
            if (ELSEWHERE.containsMatchIn(raw ?: "")) return true
            return code == 487
        }
    }
}
