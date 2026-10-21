package com.allemm.sip

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Servicio en primer plano que mantiene la extensión registrada aunque la
 * pantalla esté apagada o la app en segundo plano. Dueño del motor SIP.
 *
 * Además de lo que hace el motor, aquí vive lo propio del teléfono:
 * timbre y vibración, notificación de llamada entrante a pantalla completa,
 * modo de audio de llamada, altavoz, sensor de proximidad, wake lock y
 * cambios de red (WiFi ↔ datos).
 */
class SipService : Service() {

    companion object {
        const val ACTION_DECLINE = "com.allemm.sip.DECLINE"
        const val ACTION_HANGUP = "com.allemm.sip.HANGUP"
        const val ACTION_EXIT = "com.allemm.sip.EXIT"
        private const val CH_STATUS = "status"
        private const val CH_CALLS = "calls_v2"
        /**
         * Una sola notificación (la del servicio en primer plano) para el estado y
         * para las llamadas: Android solo acepta el estilo "llamada" (CallStyle)
         * en la notificación del servicio o con pantalla completa.
         */
        private const val NOTIF_STATUS = 1

        @Volatile var instance: SipService? = null; private set
        /** La pantalla (MainActivity) se suscribe aquí para recibir eventos. */
        @Volatile var uiListener: ((String, Map<String, Any?>) -> Unit)? = null
        @Volatile private var startedFuture = CompletableFuture<SipService>()

        /**
         * Un solo hilo para arrancar/apagar el motor y para las acciones de las
         * notificaciones. pjsua2 admite un Endpoint por proceso: si se cierra
         * sesión y se vuelve a entrar rápido, el nuevo arranque espera al apagado.
         */
        val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "sip-service") }

        /** Arranca el servicio (si no está) y espera a que el motor esté listo. NO llamar desde el hilo principal. */
        @Synchronized
        fun ensureStarted(ctx: Context, timeoutSec: Long = 30): SipService {
            check(Looper.myLooper() != Looper.getMainLooper()) { "ensureStarted desde el hilo principal" }
            instance?.let { if (it.engineReady.isDone && !it.engineReady.isCompletedExceptionally) return it }
            if (startedFuture.isDone) startedFuture = CompletableFuture()
            ContextCompat.startForegroundService(ctx, Intent(ctx, SipService::class.java))
            return startedFuture.get(timeoutSec, TimeUnit.SECONDS)
        }
    }

    lateinit var engine: SipEngine; private set
    val engineReady = CompletableFuture<Unit>()
    private val bg get() = worker
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: JSONObject

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var proximityLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null
    private var speakerOn = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var lastNetwork: Network? = null
    @Volatile var currentCaller = ""; private set
    private var statusText = "Conectando…"

    private fun showStatus(text: String = statusText) {
        statusText = text
        if (!engine.inCall) notifications.notify(NOTIF_STATUS, statusNotification(text))
    }

    private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private val notifications by lazy { getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager }

    // ------------------------------------------------------------ ciclo
    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.file = File(filesDir, "allemmsip.log")
        settings = Settings.load(this)
        Log.debug = settings.optBoolean("debug")
        createChannels()
        startInForeground(statusNotification("Conectando…"))
        engine = SipEngine(Settings.toEngine(settings)) { n, d -> onEngineEvent(n, d) }
        bg.execute {
            try {
                engine.start()
                engineReady.complete(Unit)
                startedFuture.complete(this)
                Log.app("Servicio SIP iniciado")
            } catch (t: Throwable) {
                Log.e("El motor SIP no pudo arrancar", t)
                engineReady.completeExceptionally(t)
                startedFuture.completeExceptionally(t)
            }
        }
        watchNetwork()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DECLINE, ACTION_HANGUP -> bg.execute { runCatching { engine.hangup() } }
            ACTION_EXIT -> { shutdown(); return START_NOT_STICKY }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopRinging()
        releaseLocks()
        setCallAudio(false)
        netCallback?.let { runCatching { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } }
        val e = engine
        worker.execute { runCatching { e.stop() } }
        instance = null
        super.onDestroy()
    }

    /** Cerrar sesión / Salir: desregistrar, quitar notificaciones y detener el servicio. */
    fun shutdown() {
        bg.execute {
            runCatching { engine.unregister() }
            main.post {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    fun applySettings(s: JSONObject) {
        settings = s
        Log.debug = s.optBoolean("debug")
        engine.settings = Settings.toEngine(s)
    }

    @SuppressLint("InlinedApi")
    private fun startInForeground(n: Notification) {
        val mic = ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
            (if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        try {
            ServiceCompat.startForeground(this, NOTIF_STATUS, n, types)
        } catch (t: Throwable) {
            // Reiniciado por el sistema en segundo plano: el micrófono no se puede pedir aquí.
            Log.w("startForeground con micrófono falló (${t.message}); sin micrófono")
            ServiceCompat.startForeground(this, NOTIF_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        }
    }

    // ------------------------------------------------------------ eventos
    private fun onEngineEvent(name: String, data: Map<String, Any?>) {
        main.post {
            when (name) {
                "registered" -> {
                    acquireLocks()
                    showStatus("En línea · Ext. ${engine.extension}")
                }
                "unregistered", "registration_failed" -> {
                    releaseLocks()
                    if (engine.extension.isNotEmpty()) showStatus("Fuera de línea · Ext. ${engine.extension}")
                }
                "transport_saved" -> (data["transport"] as? String)?.let {
                    settings = Settings.save(this, JSONObject().put("transport", it))
                }
                "incoming_call" -> {
                    currentCaller = data["caller"] as? String ?: ""
                    startRinging()
                    notifications.notify(NOTIF_STATUS, incomingNotification(currentCaller))
                }
                "call_progress" -> setCallAudio(true)
                "call_answered" -> {
                    stopRinging()
                    setCallAudio(true)
                    notifications.notify(NOTIF_STATUS, ongoingNotification(currentCaller.ifEmpty { "llamada" }))
                }
                "call_ended", "call_failed" -> {
                    stopRinging()
                    setCallAudio(false)
                    currentCaller = ""
                    main.postDelayed({ showStatus() }, 300)   // el motor ya soltó la llamada
                }
            }
            uiListener?.invoke(name, data)
        }
    }

    /** Llamada saliente iniciada desde la interfaz. */
    fun onOutgoingCall(number: String) {
        currentCaller = number
        main.post { setCallAudio(true); notifications.notify(NOTIF_STATUS, ongoingNotification(number)) }
    }

    // --------------------------------------------------------- red
    private fun watchNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val changed = lastNetwork != null && lastNetwork != network
                lastNetwork = network
                if (!changed) return
                Log.app("Cambió la red: avisando al motor")
                bg.execute {
                    runCatching {
                        engine.networkChanged()
                        if (!engine.isRegistered && engine.extension.isNotEmpty()) engine.reconnect()
                    }
                }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb); netCallback = cb }
    }

    // ------------------------------------------------------- locks
    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (!settings.optBoolean("keepAwake", true)) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (wakeLock?.isHeld != true) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AllemmSIP:registro").apply { setReferenceCounted(false); acquire() }
        }
        if (wifiLock?.isHeld != true) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "AllemmSIP:wifi").apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        wifiLock?.let { if (it.isHeld) it.release() }; wifiLock = null
    }

    // ------------------------------------------------------- audio
    private fun setCallAudio(active: Boolean) {
        if (active) {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= 26 && focusRequest == null) {
                focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .build().also { audio.requestAudioFocus(it) }
            }
            updateProximity()
        } else {
            setSpeaker(false)
            focusRequest?.let { audio.abandonAudioFocusRequest(it) }
            focusRequest = null
            audio.mode = AudioManager.MODE_NORMAL
            proximityLock?.let { if (it.isHeld) it.release() }
            proximityLock = null
        }
    }

    fun setSpeaker(on: Boolean): Boolean {
        speakerOn = on
        if (Build.VERSION.SDK_INT >= 31) {
            if (on) {
                audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ?.let { audio.setCommunicationDevice(it) }
            } else audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = on
        }
        updateProximity()
        return speakerOn
    }

    /** Pantalla apagada al acercar el teléfono a la oreja (solo en llamada y sin altavoz). */
    @SuppressLint("WakelockTimeout")
    private fun updateProximity() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val want = engine.inCall && !speakerOn && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)
        if (want && proximityLock?.isHeld != true) {
            proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "AllemmSIP:proximidad").apply { acquire() }
        } else if (!want) {
            proximityLock?.let { if (it.isHeld) it.release() }
            proximityLock = null
        }
    }

    private fun startRinging() {
        stopRinging()
        if (audio.ringerMode == AudioManager.RINGER_MODE_SILENT) return
        if (audio.ringerMode == AudioManager.RINGER_MODE_NORMAL) {
            runCatching {
                val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ringtone = RingtoneManager.getRingtone(this, uri)?.apply {
                    audioAttributes = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
                    if (Build.VERSION.SDK_INT >= 28) isLooping = true
                    play()
                }
            }
        }
        vibrator = if (Build.VERSION.SDK_INT >= 31) (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                   else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as Vibrator)
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0))
    }

    private fun stopRinging() {
        ringtone?.let { runCatching { it.stop() } }; ringtone = null
        vibrator?.cancel(); vibrator = null
    }

    // ------------------------------------------------- notificaciones
    private fun createChannels() {
        notifications.createNotificationChannel(NotificationChannel(CH_STATUS, "Estado de la extensión", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Mantiene la extensión registrada para recibir llamadas"
            setShowBadge(false)
        })
        notifications.createNotificationChannel(NotificationChannel(CH_CALLS, "Llamadas", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Llamadas entrantes y en curso"
            setSound(null, null)          // el timbre lo controla el servicio
            enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
    }

    private fun appIntent(extra: String? = null): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (extra != null) i.putExtra(MainActivity.EXTRA_CALL_ACTION, extra)
        return PendingIntent.getActivity(this, extra?.hashCode() ?: 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun serviceIntent(action: String) = PendingIntent.getService(this, action.hashCode(),
        Intent(this, SipService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun statusNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_allemm)
            .setContentTitle("ALLEMM SIP")
            .setContentText(text)
            .setOngoing(true)
            .setColor(0xFFC69F5A.toInt())
            .setContentIntent(appIntent())
            .addAction(0, "Salir", serviceIntent(ACTION_EXIT))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    private fun incomingNotification(caller: String): Notification {
        val person = Person.Builder().setName(caller.ifEmpty { "Desconocido" }).setImportant(true).build()
        return NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat_allemm)
            .setColor(0xFFC69F5A.toInt())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentTitle("Llamada entrante")
            .setContentText(caller)
            .setContentIntent(appIntent(MainActivity.CALL_SHOW))
            .setFullScreenIntent(appIntent(MainActivity.CALL_SHOW), true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, serviceIntent(ACTION_DECLINE), appIntent(MainActivity.CALL_ANSWER)))
            .build()
    }

    private fun ongoingNotification(who: String): Notification {
        val person = Person.Builder().setName(who).build()
        return NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat_allemm)
            .setColor(0xFFC69F5A.toInt())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setContentTitle("En llamada")
            .setContentText(who)
            .setContentIntent(appIntent(MainActivity.CALL_SHOW))
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, serviceIntent(ACTION_HANGUP)))
            .build()
    }
}
