"""Configuración persistente de ALLEMM SIP.

Se guarda en ``%LOCALAPPDATA%\\AllemmSIP\\settings.json`` (Windows) o en
``~/.local/share/allemmsip/settings.json``. Los valores por defecto reflejan
el ``config.js`` del softphone web original; el servidor SIP se captura desde
la pantalla de ajustes (no va fijo en el código porque el repositorio es
público).

Para instalaciones masivas se puede dejar un ``settings.json`` junto al
ejecutable: la primera vez que arranca la aplicación lo copia como
configuración inicial del usuario.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any

from .engine import EngineSettings

APP_NAME = "ALLEMM SIP"
APP_ID = "AllemmSIP"
VERSION = "1.0.0"

DEFAULTS: dict[str, Any] = {
    # Conexión SIP
    "sipServer": "pbx18879.pbxhosting.com.mx",   # mismo valor que el .exe anterior y el manual de MicroSIP
    "sipPort": 49999,
    "transport": "udp",             # udp | tcp | tls
    "registerExpires": 300,         # MicroSIP: "Refresco de registro" 300
    "registerTimeout": 15,
    "retryDelay": 5,
    "maxRetries": 3,
    "stunEnabled": False,           # MicroSIP: "Dirección pública" Automático, sin STUN/ICE
    "stunServers": ["stun.l.google.com:19302", "stun1.l.google.com:19302"],
    "srtp": "off",                  # off | optional | mandatory (MicroSIP: "Comunicación cifrada" desactivado)
    "sessionTimers": False,
    # Audio
    "captureDevice": "",
    "playbackDevice": "",
    "echoCancelMs": 200,
    "audioCodecs": ["PCMU", "PCMA", "G722", "opus"],
    "dtmfMode": "INFO",             # INFO | RFC2833
    # Interfaz
    "appName": "Corporativo de Viajes UVAC",
    "companyName": "Corporativo de Viajes UVAC",
    "footerText": "Desarrollado por UVAC Tech",
    "historyRetentionDays": 6,
    "callTimeout": 60,
    "autoDial": True,
    "startMinimized": False,
    # Monitoreo (panel admin PHP del proyecto web). Vacío = desactivado.
    "monitorUrl": "",
    "monitorToken": "",
    # Diagnóstico
    "debug": False,
    "pjsipLogLevel": 3,
}


def data_dir() -> Path:
    if os.environ.get("ALLEMMSIP_DATA_DIR"):
        return Path(os.environ["ALLEMMSIP_DATA_DIR"])
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / APP_ID
    return Path.home() / ".local" / "share" / "allemmsip"


def app_dir() -> Path:
    """Carpeta donde vive el ejecutable (o el código fuente)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def static_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
    return base / "allemmsip" / "static"


def settings_path() -> Path:
    return data_dir() / "settings.json"


def _merge(base: dict, extra: dict) -> dict:
    out = deepcopy(base)
    for k, v in (extra or {}).items():
        if k in out:
            out[k] = v
    return out


def load_settings() -> dict:
    path = settings_path()
    if not path.exists():
        seed = app_dir() / "settings.json"
        if seed.exists():
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(seed.read_text(encoding="utf-8"), encoding="utf-8")
            except OSError:
                pass
    if path.exists():
        try:
            return _merge(DEFAULTS, json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            logging.getLogger(__name__).exception("settings.json ilegible; se usan valores por defecto")
    return deepcopy(DEFAULTS)


def save_settings(values: dict) -> dict:
    merged = _merge(load_settings(), values)
    merged = _normalize(merged)
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return merged


def _normalize(s: dict) -> dict:
    s["sipServer"] = str(s.get("sipServer", "")).strip()
    try:
        s["sipPort"] = int(s.get("sipPort") or 5060)
    except (TypeError, ValueError):
        s["sipPort"] = 5060
    s["transport"] = str(s.get("transport", "udp")).lower()
    if s["transport"] not in ("udp", "tcp", "tls"):
        s["transport"] = "udp"
    s["dtmfMode"] = "RFC2833" if str(s.get("dtmfMode", "INFO")).upper() == "RFC2833" else "INFO"
    if s.get("srtp") not in ("off", "optional", "mandatory"):
        s["srtp"] = "optional"
    for key in ("registerExpires", "registerTimeout", "retryDelay", "maxRetries", "echoCancelMs",
                "historyRetentionDays", "callTimeout", "pjsipLogLevel"):
        try:
            s[key] = int(s.get(key, DEFAULTS[key]))
        except (TypeError, ValueError):
            s[key] = DEFAULTS[key]
    if isinstance(s.get("stunServers"), str):
        s["stunServers"] = [x.strip() for x in s["stunServers"].split(",") if x.strip()]
    if isinstance(s.get("audioCodecs"), str):
        s["audioCodecs"] = [x.strip() for x in s["audioCodecs"].split(",") if x.strip()]
    return s


def parse_server(text: str, default_port: int = 5060) -> tuple[str, int]:
    """``'pbx.midominio.com:49999'`` → ``('pbx.midominio.com', 49999)``.

    Acepta también ``sip:host:port``, ``host`` a secas (puerto por defecto) o
    una IPv6 entre corchetes ``[::1]:5060``.
    """
    text = (text or "").strip()
    for prefix in ("sip:", "sips:"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
    text = text.split("/", 1)[0].split(";", 1)[0].strip()
    if not text:
        return "", default_port
    if text.startswith("["):
        host, _, rest = text[1:].partition("]")
        port = rest.lstrip(":")
    elif text.count(":") == 1:
        host, _, port = text.partition(":")
    else:
        host, port = text, ""
    host = host.strip()
    try:
        port_n = int(port) if port else default_port
    except ValueError:
        port_n = default_port
    if not (0 < port_n < 65536):
        port_n = default_port
    return host, port_n


def engine_settings(s: dict) -> EngineSettings:
    return EngineSettings(
        sip_server=s["sipServer"],
        sip_port=int(s["sipPort"]),
        transport=s["transport"],
        register_expires=int(s["registerExpires"]),
        retry_delay=int(s["retryDelay"]),
        register_timeout=int(s["registerTimeout"]),
        stun_servers=list(s["stunServers"]) if s.get("stunEnabled", True) else [],
        codecs=list(s["audioCodecs"]),
        dtmf_mode=s["dtmfMode"],
        srtp=s["srtp"],
        capture_device=s.get("captureDevice", ""),
        playback_device=s.get("playbackDevice", ""),
        echo_cancel_ms=int(s["echoCancelMs"]),
        user_agent=f"{APP_NAME}/{VERSION}",
        log_level=int(s.get("pjsipLogLevel", 3)),
        session_timers=bool(s.get("sessionTimers", False)),
    )


def setup_logging(debug: bool = False) -> Path:
    """Log a archivo (la app de ventana no tiene consola)."""
    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    log_path = d / "allemmsip.log"
    if sys.stdout is None or sys.stderr is None:
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream
    root = logging.getLogger()
    if not any(isinstance(h, logging.FileHandler) for h in root.handlers):
        try:
            from logging.handlers import RotatingFileHandler

            handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
        except Exception:  # noqa: BLE001
            handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    logging.getLogger("pjsip").setLevel(logging.DEBUG if debug else logging.INFO)
    return log_path
