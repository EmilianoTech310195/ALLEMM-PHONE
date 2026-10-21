package com.allemm.sip

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File

/**
 * Pantalla única: la MISMA interfaz que la versión de escritorio
 * (allemmsip/static, empaquetada como assets) dentro de un WebView.
 * El motor SIP vive en SipService; aquí solo se muestran sus eventos.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_CALL_ACTION = "call_action"
        const val CALL_SHOW = "show"
        const val CALL_ANSWER = "answer"
        private const val REQ_PERMS = 10
        private const val URL = "https://appassets.androidplatform.net/assets/index.html"
    }

    private lateinit var web: WebView
    private var pageReady = false
    private var launchNumber = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.file = File(filesDir, "allemmsip.log")
        window.statusBarColor = Color.parseColor("#0A0A0C")
        window.navigationBarColor = Color.parseColor("#0A0A0C")

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0A0C"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(JsBridge(this@MainActivity), "AllemmAndroid")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    if (u.host == "appassets.androidplatform.net") return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) { pageReady = true }
            }
        }
        setContentView(web)

        SipService.uiListener = { name, data -> dispatch(name, data) }
        handleIntent(intent)
        web.loadUrl(URL)

        // Atrás: mandar la app al fondo (la extensión sigue registrada), no cerrarla.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })

        requestPermissionsIfNeeded()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
        if (launchNumber.isNotEmpty() && pageReady) {
            dispatch("launch_number", mapOf("number" to takeLaunchNumber()))
        }
    }

    override fun onDestroy() {
        if (SipService.uiListener != null) SipService.uiListener = null
        web.destroy()
        super.onDestroy()
    }

    /** Enlaces tel:/sip: (click-to-call) y acciones de la notificación de llamada. */
    private fun handleIntent(i: Intent?) {
        if (i == null) return
        when (i.getStringExtra(EXTRA_CALL_ACTION)) {
            CALL_ANSWER -> { showOverLockScreen(true); SipService.worker.execute { runCatching { SipService.instance?.engine?.answer() } } }
            CALL_SHOW -> showOverLockScreen(true)
        }
        val data: Uri? = i.data
        if (data != null && (i.action == Intent.ACTION_VIEW || i.action == Intent.ACTION_DIAL || i.action == Intent.ACTION_CALL)) {
            val raw = Uri.decode(data.schemeSpecificPart ?: "")
            launchNumber = raw.substringBefore('@').replace(Regex("[^\\d*#]"), "")
        }
    }

    fun takeLaunchNumber(): String { val n = launchNumber; launchNumber = ""; return n }

    /** Mostrar sobre la pantalla de bloqueo solo mientras hay una llamada. */
    private fun showOverLockScreen(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on)
            setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            val f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) window.addFlags(f) else window.clearFlags(f)
        }
    }

    /** Evento del motor → interfaz: AllemmBridge.dispatch({name, data}). */
    fun dispatch(name: String, data: Map<String, Any?>) {
        runOnUiThread {
            when (name) {
                "incoming_call" -> showOverLockScreen(true)
                "call_ended", "call_failed" -> showOverLockScreen(false)
            }
            val payload = JSONObject().put("name", name).put("data", JSONObject(data)).toString()
            web.evaluateJavascript("window.AllemmBridge && window.AllemmBridge.dispatch($payload);", null)
        }
    }

    // ------------------------------------------------------------ permisos
    private fun requestPermissionsIfNeeded() {
        val wanted = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
        val missing = wanted.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return
        permissions.forEachIndexed { i, p ->
            if (p == Manifest.permission.RECORD_AUDIO && grantResults.getOrNull(i) != PackageManager.PERMISSION_GRANTED) {
                dispatch("engine_error", mapOf("message" to "Sin permiso de micrófono no se puede hablar en las llamadas. Actívalo en Ajustes de Android → Apps → ALLEMM SIP → Permisos."))
            }
        }
    }

    /** Una sola vez: pedir que Android no "duerma" la app, o dejará de recibir llamadas con la pantalla apagada. */
    @SuppressLint("BatteryLife")
    fun requestBatteryExemptionOnce() {
        val prefs = getSharedPreferences("allemmsip", Context.MODE_PRIVATE)
        if (prefs.getBoolean("askedBattery", false)) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        runOnUiThread {
            runCatching {
                startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
        }
    }
}
