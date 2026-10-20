"""Motor SIP de escritorio sobre PJSIP (pjsua2).

Reemplaza a JsSIP + WebRTC del softphone web. Habla SIP por UDP, TCP o TLS
directo con el PBX y usa la tarjeta de sonido de Windows, sin WebSocket ni
navegador.

Diseño:

* Todas las llamadas a pjsua2 se hacen desde UN solo hilo (``_worker``), que
  es el que crea la librería. pjsua2 exige que cada hilo que la use esté
  registrado; concentrarlo en uno evita ese problema y las carreras.
* Los callbacks de PJSIP (registro, llamada entrante, cambios de estado)
  llegan en hilos internos de PJSIP. Aquí solo se traducen a eventos y se
  entregan al ``listener``; el trabajo pesado se hace fuera.
* Los nombres de los eventos y de las causas de error imitan a JsSIP
  (``'Authentication Error'``, ``'Canceled'``, ``'Busy'``...) para que la
  interfaz original (app.js / alerts.js) siga funcionando sin cambios.

Eventos emitidos (nombre, datos):

    registered            {}
    unregistered          {}
    registration_failed   {cause, code, reason}
    incoming_call         {caller, display}
    call_progress         {}
    call_answered         {}
    call_ended            {}
    call_failed           {cause, code, taken_by_colleague}
    transfer_status       {code, reason, final}
    health                {state}   ok | warning | error | offline
"""

from __future__ import annotations

import logging
import queue
import re
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

log = logging.getLogger("allemmsip.engine")
pjlog = logging.getLogger("pjsip")

try:  # pjsua2 solo existe cuando se compiló PJSIP (ver third_party/pjsua2)
    import pjsua2 as pj
except Exception as _exc:  # noqa: BLE001
    pj = None  # type: ignore[assignment]
    _PJ_IMPORT_ERROR = _exc
else:
    _PJ_IMPORT_ERROR = None


Listener = Callable[[str, dict], None]


@dataclass
class EngineSettings:
    """Parámetros que el motor necesita (ver config.py para los valores)."""

    sip_server: str = ""
    sip_port: int = 5060
    transport: str = "udp"            # udp | tcp | tls
    register_expires: int = 300
    retry_delay: int = 5
    register_timeout: int = 15
    stun_servers: list[str] = field(default_factory=list)
    codecs: list[str] = field(default_factory=lambda: ["PCMU", "PCMA", "opus", "G722"])
    dtmf_mode: str = "INFO"           # INFO | RFC2833
    srtp: str = "optional"            # off | optional | mandatory
    capture_device: str = ""          # nombre del micrófono ("" = predeterminado)
    playback_device: str = ""         # nombre del altavoz/audífonos
    echo_cancel_ms: int = 200
    user_agent: str = "ALLEMM SIP/1.0"
    log_level: int = 3
    local_port: int = 0               # 0 = puerto local aleatorio
    session_timers: bool = False
    auto_fallback_tcp: bool = True    # si UDP no responde, reintentar por TCP


# --------------------------------------------------------------------------
# Utilidades puras (sin pjsua2) — se prueban sin compilar nada
# --------------------------------------------------------------------------

_URI_USER_RE = re.compile(r"sips?:([^@;>]+)")
_DISPLAY_RE = re.compile(r'^\s*"?([^"<]*?)"?\s*<')
_REASON_ELSEWHERE_RE = re.compile(r"completed elsewhere|answered elsewhere|cause=200", re.I)


def uri_user(uri: str) -> str:
    """``'"Juan" <sip:2042@pbx>'`` → ``'2042'``."""
    m = _URI_USER_RE.search(uri or "")
    return m.group(1) if m else (uri or "").strip()


def uri_display(uri: str) -> str:
    m = _DISPLAY_RE.match(uri or "")
    return (m.group(1).strip() if m else "")


def registration_cause(code: int, reason: str, status: int) -> str:
    """Traduce el resultado de REGISTER a las causas que espera la interfaz."""
    reason = (reason or "").lower()
    if code in (401, 407):
        return "Authentication Error"
    if code == 403:
        return "Forbidden"
    if code == 408 or "timed out" in reason or "timeout" in reason:
        return "Request Timeout"
    if code == 500:
        return "Internal Server Error"
    if code == 503 and ("resolve" in reason or "transport" in reason or "unable" in reason or status != 0):
        return "Connection Error"
    if code == 503:
        return "Service Unavailable"
    if code == 404:
        return "Not Found"
    if code == 0 or status != 0:
        return "Connection Error"
    return f"{code} {reason}".strip()


def call_failure_cause(code: int, *, local_hangup: bool, incoming: bool) -> str:
    """Causa estilo JsSIP para una llamada que terminó sin establecerse."""
    if local_hangup:
        # Saliente cancelada por el usuario → 'Canceled' (app.js lo trata como
        # normal). Entrante rechazada por el usuario → 'Rejected' (si dijéramos
        # 'Canceled' la interfaz creería que la tomó un compañero).
        return "Rejected" if incoming else "Canceled"
    return {
        404: "Not Found",
        408: "Request Timeout",
        410: "Unavailable",
        480: "Unavailable",
        486: "Busy",
        487: "Canceled",
        500: "Internal Server Error",
        503: "Service Unavailable",
        600: "Busy",
        603: "Rejected",
    }.get(code, "Rejected" if code >= 400 else "Canceled")


def taken_by_colleague(code: int, raw_message: str, *, incoming: bool, local_hangup: bool) -> bool:
    """¿La llamada entrante la contestó otro agente del grupo de timbrado?"""
    if not incoming or local_hangup:
        return False
    if _REASON_ELSEWHERE_RE.search(raw_message or ""):
        return True
    return code == 487


def pick_device(devices: list[dict], wanted_name: str, kind: str) -> int:
    """Índice del dispositivo cuyo nombre coincide, o -1 (predeterminado)."""
    if not wanted_name:
        return -1
    key = "inputCount" if kind == "capture" else "outputCount"
    for d in devices:
        if d.get(key, 0) > 0 and d.get("name") == wanted_name:
            return int(d["id"])
    for d in devices:  # coincidencia parcial (Windows a veces recorta nombres)
        if d.get(key, 0) > 0 and wanted_name.lower() in str(d.get("name", "")).lower():
            return int(d["id"])
    return -1


# --------------------------------------------------------------------------
# Clases pjsua2 (solo se definen si la librería está disponible)
# --------------------------------------------------------------------------

if pj is not None:

    class _LogWriter(pj.LogWriter):
        _LEVELS = {0: logging.CRITICAL, 1: logging.ERROR, 2: logging.WARNING, 3: logging.INFO}

        def write(self, entry):  # noqa: N802 - nombre fijado por pjsua2
            try:
                pjlog.log(self._LEVELS.get(entry.level, logging.DEBUG), entry.msg.rstrip())
            except Exception:  # noqa: BLE001 - nunca romper PJSIP por un log
                pass

    class _Account(pj.Account):
        def __init__(self, engine: "SipEngine"):
            super().__init__()
            self.engine = engine

        def onRegState(self, prm):  # noqa: N802
            self.engine._on_reg_state(prm.code, prm.reason, prm.expiration, prm.status)

        def onIncomingCall(self, prm):  # noqa: N802
            self.engine._on_incoming_call(self, prm.callId)

    class _Call(pj.Call):
        def __init__(self, engine: "SipEngine", acc: pj.Account, call_id=None):
            if call_id is None:
                super().__init__(acc)
            else:
                super().__init__(acc, call_id)
            self.engine = engine
            self.incoming = call_id is not None
            self.confirmed = False
            self.local_hangup = False
            self.silent = False          # rechazada con 486: no genera eventos a la interfaz
            self.last_raw_message = ""

        def onCallState(self, prm):  # noqa: N802
            raw = ""
            try:
                e = prm.e
                if e.type == pj.PJSIP_EVENT_TSX_STATE and e.body.tsxState.type == pj.PJSIP_EVENT_RX_MSG:
                    raw = e.body.tsxState.src.rdata.wholeMsg or ""
            except Exception:  # noqa: BLE001
                raw = ""
            if raw:
                self.last_raw_message = raw
            self.engine._on_call_state(self)

        def onCallMediaState(self, prm):  # noqa: N802
            self.engine._on_call_media_state(self)

        def onCallTransferStatus(self, prm):  # noqa: N802
            self.engine._emit("transfer_status", {"code": prm.statusCode, "reason": prm.reason,
                                                  "final": bool(prm.finalNotify)})
            if prm.finalNotify and 200 <= prm.statusCode < 300:
                # Transferencia aceptada: colgamos nuestra pata de la llamada.
                self.engine._post(lambda: self.engine._hangup_call(self, code=0))


class EngineUnavailable(RuntimeError):
    pass


class SipEngine:
    """Fachada del motor. Métodos públicos seguros desde cualquier hilo."""

    def __init__(self, settings: EngineSettings, listener: Optional[Listener] = None):
        self.settings = settings
        self._listener: Listener = listener or (lambda name, data: None)
        self._jobs: "queue.Queue[tuple[Callable[[], Any], Future]]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._running = False
        self._ep = None
        self._log_writer = None
        self._acc = None
        self._call = None
        self._dead_calls: list[Any] = []
        self._muted = False
        self._on_hold = False
        self.extension = ""
        self._password = ""
        self.is_registered = False
        self._reg_timer: Optional[threading.Timer] = None
        self._lock = threading.RLock()

    # ---- infraestructura de hilo ------------------------------------------

    @staticmethod
    def available() -> bool:
        return pj is not None

    @staticmethod
    def import_error() -> str:
        return "" if _PJ_IMPORT_ERROR is None else str(_PJ_IMPORT_ERROR)

    def set_listener(self, listener: Listener) -> None:
        self._listener = listener

    def _emit(self, name: str, data: Optional[dict] = None) -> None:
        try:
            self._listener(name, data or {})
        except Exception:  # noqa: BLE001
            log.exception("El receptor de eventos falló en %s", name)

    def _post(self, fn: Callable[[], Any]) -> Future:
        fut: Future = Future()
        self._jobs.put((fn, fut))
        return fut

    def _run(self, fn: Callable[[], Any], timeout: float = 15.0) -> Any:
        if threading.current_thread() is self._worker:
            return fn()
        if not self._running:
            raise EngineUnavailable("El motor SIP no está iniciado")
        return self._post(fn).result(timeout=timeout)

    def _loop(self, ready: Future) -> None:
        try:
            self._lib_start()
            ready.set_result(True)
        except Exception as exc:  # noqa: BLE001
            log.exception("No se pudo iniciar PJSIP")
            ready.set_exception(exc)
            self._running = False
            self._lib_stop()
            if SipEngine._active is self:
                SipEngine._active = None
            return
        while self._running:
            try:
                fn, fut = self._jobs.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                fut.set_result(fn())
            except Exception as exc:  # noqa: BLE001
                log.exception("Trabajo del motor falló")
                fut.set_exception(exc)
        self._lib_stop()

    # ---- ciclo de vida -----------------------------------------------------

    _active: "Optional[SipEngine]" = None   # pjsua2 solo admite un Endpoint por proceso

    def start(self) -> None:
        if pj is None:
            raise EngineUnavailable(
                "pjsua2 no está disponible: " + str(_PJ_IMPORT_ERROR)
                + ". Compila PJSIP con tools\\build-pjsip-windows.ps1 (ver README)."
            )
        if self._running:
            return
        if SipEngine._active is not None and SipEngine._active is not self:
            raise RuntimeError("Ya hay un motor SIP activo en este proceso (pjsua2 es único por proceso)")
        SipEngine._active = self
        self._running = True
        ready: Future = Future()
        self._worker = threading.Thread(target=self._loop, args=(ready,), name="sip-engine", daemon=True)
        self._worker.start()
        ready.result(timeout=30)

    def stop(self) -> None:
        if not self._running:
            return
        try:
            self._run(self._unregister_job, timeout=10)
        except Exception:  # noqa: BLE001
            pass
        self._running = False
        if self._worker:
            self._worker.join(timeout=15)
        if SipEngine._active is self:
            SipEngine._active = None

    def _lib_start(self) -> None:
        s = self.settings
        self._ep = pj.Endpoint()
        self._ep.libCreate()

        cfg = pj.EpConfig()
        cfg.uaConfig.userAgent = s.user_agent
        cfg.uaConfig.maxCalls = 4
        cfg.uaConfig.threadCnt = 1
        cfg.uaConfig.mainThreadOnly = False
        if s.stun_servers:
            cfg.uaConfig.stunServer = pj.StringVector(list(s.stun_servers))
            cfg.uaConfig.stunIgnoreFailure = True
            cfg.uaConfig.stunTryIpv6 = False
        cfg.logConfig.level = int(s.log_level)
        cfg.logConfig.consoleLevel = 0
        cfg.logConfig.msgLogging = int(s.log_level) >= 5   # paquetes SIP solo en diagnóstico
        self._log_writer = _LogWriter()
        cfg.logConfig.writer = self._log_writer
        cfg.medConfig.ecTailLen = int(s.echo_cancel_ms)
        cfg.medConfig.noVad = True
        cfg.medConfig.sndAutoCloseTime = 1
        self._ep.libInit(cfg)

        # Se crean los tres transportes; el que se usa lo decide la URI del
        # registrador (";transport=tcp"). Así se puede cambiar de UDP a TCP
        # sin reiniciar la librería (redes que bloquean UDP).
        self._transports: dict[str, bool] = {}
        for name, kind in (("udp", pj.PJSIP_TRANSPORT_UDP), ("tcp", pj.PJSIP_TRANSPORT_TCP),
                           ("tls", pj.PJSIP_TRANSPORT_TLS)):
            tcfg = pj.TransportConfig()
            tcfg.port = int(s.local_port)
            if kind == pj.PJSIP_TRANSPORT_TLS:
                tcfg.tlsConfig.verifyServer = False
            try:
                self._ep.transportCreate(kind, tcfg)
                self._transports[name] = True
            except Exception as exc:  # noqa: BLE001 - p. ej. TLS sin SSL compilado
                self._transports[name] = False
                log.warning("Transporte %s no disponible: %s", name.upper(), exc)
        if not self._transports.get(s.transport.lower()):
            raise RuntimeError(f"El transporte {s.transport.upper()} no está disponible")
        self._ep.libStart()
        self._apply_codecs()
        self._apply_audio_devices()
        log.info("PJSIP %s iniciado (%s)", self._ep.libVersion().full, s.transport.upper())

    def _lib_stop(self) -> None:
        try:
            if self._call is not None:
                self._hangup_call(self._call, code=0)
            self._call = None
            self._dead_calls.clear()
            if self._acc is not None:
                try:
                    self._acc.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                self._acc = None
            if self._ep is not None:
                self._ep.libDestroy()
        except Exception:  # noqa: BLE001
            log.exception("Error al apagar PJSIP")
        finally:
            self._ep = None

    # ---- audio y códecs ----------------------------------------------------

    def _apply_codecs(self) -> None:
        wanted = [c.lower() for c in self.settings.codecs]
        for info in self._ep.codecEnum2():
            name = info.codecId.split("/")[0].lower()
            prio = 0
            if name in wanted:
                prio = 255 - wanted.index(name)
            try:
                self._ep.codecSetPriority(info.codecId, prio)
            except Exception:  # noqa: BLE001
                pass

    def _devices_job(self) -> list[dict]:
        adm = self._ep.audDevManager()
        try:
            adm.refreshDevs()
        except Exception:  # noqa: BLE001
            pass
        out = []
        for i, d in enumerate(adm.enumDev2()):
            out.append({"id": i, "name": d.name, "driver": d.driver,
                        "inputCount": d.inputCount, "outputCount": d.outputCount})
        return out

    def _apply_audio_devices(self) -> None:
        adm = self._ep.audDevManager()
        devices = self._devices_job()
        if not devices:
            log.warning("Sin dispositivos de audio: se usa el dispositivo nulo")
            adm.setNullDev()
            return
        cap = pick_device(devices, self.settings.capture_device, "capture")
        play = pick_device(devices, self.settings.playback_device, "playback")
        try:
            adm.setCaptureDev(cap)
            adm.setPlaybackDev(play)
        except Exception:  # noqa: BLE001
            log.exception("No se pudo fijar el dispositivo de audio; se usa el predeterminado")
            try:
                adm.setCaptureDev(-1)
                adm.setPlaybackDev(-1)
            except Exception:  # noqa: BLE001
                adm.setNullDev()

    def use_null_audio(self) -> None:
        """Sin tarjeta de sonido (pruebas automáticas / servidores)."""
        self._run(lambda: self._ep.audDevManager().setNullDev())

    def list_audio_devices(self) -> list[dict]:
        return self._run(self._devices_job)

    def set_audio_devices(self, capture: str, playback: str) -> None:
        self.settings.capture_device = capture or ""
        self.settings.playback_device = playback or ""
        self._run(self._apply_audio_devices)

    # ---- registro ----------------------------------------------------------

    def _domain(self) -> str:
        """``host`` o ``host:puerto`` (MicroSIP pone el puerto también en el dominio)."""
        s = self.settings
        default_port = 5061 if s.transport.lower() == "tls" else 5060
        host = s.sip_server.strip()
        port = f":{s.sip_port}" if s.sip_port and int(s.sip_port) != default_port else ""
        return f"{host}{port}"

    def _server_uri(self) -> str:
        s = self.settings
        tr = "" if s.transport.lower() == "udp" else f";transport={s.transport.lower()}"
        return f"sip:{self._domain()}{tr}"

    def register(self, extension: str, password: str) -> None:
        """Equivalente a ``UvacSIP.init(ext, pass)``."""
        self.extension = str(extension).strip()
        self._password = password
        self._fallback_done = False
        self._run(self._register_job)

    def _register_job(self) -> None:
        self._destroy_account()
        s = self.settings
        if not s.sip_server.strip():
            self._emit("registration_failed", {"cause": "Connection Error", "code": 0,
                                               "reason": "No hay servidor SIP configurado"})
            return
        cfg = pj.AccountConfig()
        cfg.idUri = f"sip:{self.extension}@{self._domain()}"
        cfg.regConfig.registrarUri = self._server_uri()
        cfg.regConfig.registerOnAdd = True
        cfg.regConfig.timeoutSec = int(s.register_expires)
        cfg.regConfig.retryIntervalSec = int(s.retry_delay)
        cfg.regConfig.firstRetryIntervalSec = max(1, int(s.retry_delay) // 2)
        cfg.regConfig.randomRetryIntervalSec = 2
        cfg.regConfig.dropCallsOnFail = False
        cfg.sipConfig.authCreds.append(pj.AuthCredInfo("digest", "*", self.extension, 0, self._password))
        if s.transport.lower() != "udp":
            cfg.sipConfig.proxies.append(self._server_uri() + ";lr")
        cfg.natConfig.contactRewriteUse = 1
        cfg.natConfig.viaRewriteUse = 1
        cfg.natConfig.sdpNatRewriteUse = 1
        cfg.natConfig.udpKaIntervalSec = 15 if s.transport.lower() == "udp" else 0
        cfg.mediaConfig.srtpUse = {
            "off": pj.PJMEDIA_SRTP_DISABLED,
            "mandatory": pj.PJMEDIA_SRTP_MANDATORY,
        }.get(s.srtp, pj.PJMEDIA_SRTP_OPTIONAL)
        cfg.mediaConfig.srtpSecureSignaling = 0
        cfg.callConfig.timerUse = pj.PJSUA_SIP_TIMER_OPTIONAL if s.session_timers else pj.PJSUA_SIP_TIMER_INACTIVE
        self._acc = _Account(self)
        self._acc.create(cfg, True)
        self._emit("health", {"state": "warning"})
        self._arm_register_timeout()

    def add_local_account(self, user: str = "local") -> str:
        """Cuenta sin registro (llamadas directas IP a IP). Solo pruebas."""
        def job():
            self._destroy_account()
            cfg = pj.AccountConfig()
            cfg.idUri = f"sip:{user}@127.0.0.1"
            cfg.regConfig.registerOnAdd = False
            cfg.mediaConfig.srtpUse = pj.PJMEDIA_SRTP_DISABLED
            cfg.callConfig.timerUse = pj.PJSUA_SIP_TIMER_INACTIVE
            self._acc = _Account(self)
            self._acc.create(cfg, True)
            self.is_registered = True
            return cfg.idUri
        return self._run(job)

    def local_port(self) -> int:
        def job():
            for t in self._ep.transportEnum():
                info = self._ep.transportGetInfo(t)
                return int(info.localName.rsplit(":", 1)[-1])
            return 0
        return self._run(job)

    def _arm_register_timeout(self) -> None:
        self._cancel_register_timeout()
        secs = int(self.settings.register_timeout or 15)
        self._reg_timer = threading.Timer(secs, self._on_register_timeout)
        self._reg_timer.daemon = True
        self._reg_timer.start()

    def _on_register_timeout(self) -> None:
        """Sin respuesta del PBX: probar TCP si veníamos por UDP, si no, fallar."""
        if self.is_registered:
            return
        secs = int(self.settings.register_timeout or 15)
        if self._can_fallback_to_tcp():
            log.warning("UDP sin respuesta en %ss: reintentando por TCP", secs)
            self.settings.transport = "tcp"
            self._fallback_done = True
            self._emit("health", {"state": "warning"})
            self._emit("transport_fallback", {"from": "udp", "to": "tcp"})
            self._post(self._register_job)
            return
        self._emit("health", {"state": "error"})
        self._emit("registration_failed", {"cause": "Connection Timeout", "code": 0,
                                           "reason": f"Sin respuesta del PBX en {secs}s"})

    def _can_fallback_to_tcp(self) -> bool:
        return (bool(self.settings.auto_fallback_tcp)
                and self.settings.transport.lower() == "udp"
                and not getattr(self, "_fallback_done", False)
                and bool(getattr(self, "_transports", {}).get("tcp", False)))

    def _cancel_register_timeout(self) -> None:
        if self._reg_timer is not None:
            self._reg_timer.cancel()
            self._reg_timer = None

    def _destroy_account(self) -> None:
        self._cancel_register_timeout()
        if self._call is not None:
            self._hangup_call(self._call, code=0)
            self._call = None
        if self._acc is not None:
            try:
                self._acc.shutdown()
            except Exception:  # noqa: BLE001
                pass
            self._acc = None
        self.is_registered = False

    def _unregister_job(self) -> None:
        self._destroy_account()
        self._emit("health", {"state": "offline"})

    def unregister(self) -> None:
        """Equivalente a ``UvacSIP.disconnect()``."""
        self._run(self._unregister_job)
        self.is_registered = False

    def reconnect(self) -> None:
        """Equivalente a ``UvacSIP.reconnect()``: rehace la cuenta y registra."""
        if not self.extension:
            return
        self._run(self._register_job)

    def network_changed(self) -> None:
        """Avisar a PJSIP que cambió la red (WiFi ↔ cable, VPN...)."""
        def job():
            if self._ep is None:
                return
            prm = pj.IpChangeParam()
            prm.restartListener = True
            prm.restartLisDelay = 500
            self._ep.handleIpChange(prm)
        try:
            self._run(job)
        except Exception:  # noqa: BLE001
            log.exception("handleIpChange falló")

    def _on_reg_state(self, code: int, reason: str, expiration: int, status: int) -> None:
        log.info("REGISTER → %s %s (exp=%s status=%s)", code, reason, expiration, status)
        if code == 200 and expiration > 0 and status == 0:
            self._cancel_register_timeout()
            self.is_registered = True
            self._emit("health", {"state": "ok"})
            self._emit("registered", {})
            return
        if code == 200 and expiration == 0:
            self.is_registered = False
            self._emit("health", {"state": "offline"})
            self._emit("unregistered", {})
            return
        was = self.is_registered
        self.is_registered = False
        self._cancel_register_timeout()
        cause = registration_cause(code, reason, status)
        self._emit("health", {"state": "error"})
        if was:
            self._emit("unregistered", {})
        self._emit("registration_failed", {"cause": cause, "code": code, "reason": reason})

    # ---- llamadas ----------------------------------------------------------

    @property
    def in_call(self) -> bool:
        return self._call is not None

    @property
    def call_established(self) -> bool:
        c = self._call
        return bool(c is not None and c.confirmed)

    @property
    def muted(self) -> bool:
        return self._muted

    def make_call(self, number: str) -> bool:
        number = str(number).strip()
        if not number.startswith(("sip:", "sips:")):
            number = re.sub(r"[^\d*#+]", "", number)
        if not number:
            return False

        def job() -> bool:
            if self._acc is None or not self.is_registered:
                return False
            if self._call is not None:
                return False
            target = number if number.startswith(("sip:", "sips:")) else f"sip:{number}@{self._domain()}"
            call = _Call(self, self._acc)
            prm = pj.CallOpParam(True)
            prm.opt.audioCount = 1
            prm.opt.videoCount = 0
            self._call = call
            self._muted = False
            self._on_hold = False
            try:
                call.makeCall(target, prm)
            except Exception:  # noqa: BLE001
                log.exception("makeCall falló")
                self._call = None
                self._dead_calls.append(call)
                return False
            log.info("Llamando a %s", target)
            return True
        return bool(self._run(job))

    def call_direct(self, uri: str) -> bool:
        """Llamar a una URI SIP completa (pruebas IP a IP)."""
        return self.make_call(uri if uri.startswith("sip:") else "sip:" + uri)

    def answer(self) -> bool:
        def job() -> bool:
            call = self._call
            if call is None or not call.incoming or call.confirmed:
                return False
            prm = pj.CallOpParam()
            prm.statusCode = pj.PJSIP_SC_OK
            prm.opt.audioCount = 1
            prm.opt.videoCount = 0
            call.answer(prm)
            return True
        return bool(self._run(job))

    def hangup(self) -> bool:
        def job() -> bool:
            call = self._call
            if call is None:
                return False
            call.local_hangup = True
            code = 0
            if call.incoming and not call.confirmed:
                code = pj.PJSIP_SC_DECLINE
            self._hangup_call(call, code=code)
            return True
        return bool(self._run(job))

    def _hangup_call(self, call, code: int = 0) -> None:
        try:
            prm = pj.CallOpParam()
            if code:
                prm.statusCode = code
            call.hangup(prm)
        except Exception:  # noqa: BLE001
            log.debug("hangup ignorado (la llamada ya terminó)")

    def toggle_mute(self) -> bool:
        def job() -> bool:
            self._muted = not self._muted
            self._apply_mute()
            return self._muted
        return bool(self._run(job))

    def set_mute(self, muted: bool) -> bool:
        def job() -> bool:
            self._muted = bool(muted)
            self._apply_mute()
            return self._muted
        return bool(self._run(job))

    def _apply_mute(self) -> None:
        call = self._call
        if call is None or not call.confirmed:
            return
        try:
            am = call.getAudioMedia(-1)
            cap = self._ep.audDevManager().getCaptureDevMedia()
            if self._muted:
                cap.stopTransmit(am)
            else:
                cap.startTransmit(am)
        except Exception:  # noqa: BLE001
            log.exception("No se pudo cambiar el mute")

    def hold(self, on: bool) -> bool:
        def job() -> bool:
            call = self._call
            if call is None or not call.confirmed:
                return False
            prm = pj.CallOpParam(True)
            if on:
                call.setHold(prm)
            else:
                prm.opt.flag |= pj.PJSUA_CALL_UNHOLD
                call.reinvite(prm)
            self._on_hold = bool(on)
            return True
        return bool(self._run(job))

    def transfer(self, number: str) -> bool:
        number = re.sub(r"[^\d*#+]", "", str(number))

        def job() -> bool:
            call = self._call
            if call is None or not call.confirmed or not number:
                return False
            target = f"sip:{number}@{self._domain()}"
            call.xfer(target, pj.CallOpParam())
            log.info("Transferencia a %s", target)
            return True
        return bool(self._run(job))

    def send_dtmf(self, tone: str) -> bool:
        tone = re.sub(r"[^0-9A-Da-d*#]", "", str(tone))

        def job() -> bool:
            call = self._call
            if call is None or not call.confirmed or not tone:
                return False
            prm = pj.CallSendDtmfParam()
            prm.method = (pj.PJSUA_DTMF_METHOD_SIP_INFO if self.settings.dtmf_mode.upper() == "INFO"
                          else pj.PJSUA_DTMF_METHOD_RFC2833)
            prm.duration = 160
            prm.digits = tone
            call.sendDtmf(prm)
            return True
        return bool(self._run(job))

    # ---- callbacks (hilo de PJSIP) ------------------------------------------

    def _on_incoming_call(self, acc, call_id: int) -> None:
        call = _Call(self, acc, call_id)
        try:
            ci = call.getInfo()
            remote = ci.remoteUri
        except Exception:  # noqa: BLE001
            remote = ""
        caller = uri_user(remote)
        if self._call is not None:
            # Ocupado: 486 para que el PBX la mande de inmediato a otro agente.
            log.info("Ocupado: segunda llamada de %s rechazada con 486", caller)
            call.silent = True
            self._dead_calls.append(call)
            self._hangup_call(call, code=pj.PJSIP_SC_BUSY_HERE)
            return
        self._call = call
        self._muted = False
        self._on_hold = False
        try:
            prm = pj.CallOpParam()
            prm.statusCode = pj.PJSIP_SC_RINGING
            call.answer(prm)
        except Exception:  # noqa: BLE001
            log.exception("No se pudo enviar 180 Ringing")
        log.info("Llamada entrante de %s", caller)
        self._emit("incoming_call", {"caller": caller, "display": uri_display(remote)})

    def _on_call_state(self, call) -> None:
        try:
            ci = call.getInfo()
        except Exception:  # noqa: BLE001
            return
        state = ci.state
        if call.silent:
            if state == pj.PJSIP_INV_STATE_DISCONNECTED:
                self._post(self._purge_dead_calls)
            return
        if state == pj.PJSIP_INV_STATE_EARLY and not call.incoming:
            self._emit("call_progress", {})
        elif state == pj.PJSIP_INV_STATE_CONFIRMED:
            if not call.confirmed:
                call.confirmed = True
                self._emit("call_answered", {})
        elif state == pj.PJSIP_INV_STATE_DISCONNECTED:
            code = int(ci.lastStatusCode)
            if call is self._call:
                self._call = None
            self._dead_calls.append(call)
            # Limpiar objetos muertos fuera del callback (regla de pjsua2).
            self._post(self._purge_dead_calls)
            if call.confirmed:
                log.info("Llamada terminada (%s)", code)
                self._emit("call_ended", {"code": code})
            else:
                cause = call_failure_cause(code, local_hangup=call.local_hangup, incoming=call.incoming)
                taken = taken_by_colleague(code, call.last_raw_message, incoming=call.incoming,
                                           local_hangup=call.local_hangup)
                log.info("Llamada no establecida: %s (%s) compañero=%s", cause, code, taken)
                self._emit("call_failed", {"cause": cause, "code": code, "taken_by_colleague": taken})

    def _purge_dead_calls(self) -> None:
        self._dead_calls = [c for c in self._dead_calls if self._still_active(c)]

    @staticmethod
    def _still_active(call) -> bool:
        try:
            return bool(call.isActive())
        except Exception:  # noqa: BLE001
            return False

    def _on_call_media_state(self, call) -> None:
        try:
            ci = call.getInfo()
            for mi in ci.media:
                if mi.type != pj.PJMEDIA_TYPE_AUDIO:
                    continue
                if mi.status in (pj.PJSUA_CALL_MEDIA_ACTIVE, pj.PJSUA_CALL_MEDIA_REMOTE_HOLD):
                    am = call.getAudioMedia(mi.index)
                    adm = self._ep.audDevManager()
                    am.startTransmit(adm.getPlaybackDevMedia())
                    if not self._muted:
                        adm.getCaptureDevMedia().startTransmit(am)
        except Exception:  # noqa: BLE001
            log.exception("No se pudo conectar el audio de la llamada")

    # ---- estado para la interfaz --------------------------------------------

    def snapshot(self) -> dict:
        call = self._call
        return {
            "registered": self.is_registered,
            "extension": self.extension,
            "inCall": call is not None,
            "established": bool(call is not None and call.confirmed),
            "incoming": bool(call is not None and call.incoming),
            "muted": self._muted,
            "onHold": self._on_hold,
            "server": self.settings.sip_server,
            "transport": self.settings.transport,
            "engine": "pjsua2 " + (self._ep.libVersion().full if self._ep else ""),
        }


def wait_for(predicate: Callable[[], bool], timeout: float = 10.0, step: float = 0.05) -> bool:
    """Pequeña ayuda para pruebas: espera a que se cumpla una condición."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(step)
    return bool(predicate())
