"""Puente entre la interfaz (HTML/JS en pywebview) y el motor SIP.

* ``JsApi``: lo que la interfaz llama como ``window.pywebview.api.<método>``.
  Cada método devuelve datos serializables en JSON.
* Los eventos del motor viajan al revés con ``window.evaluate_js`` hacia
  ``AllemmBridge.dispatch(evento)`` (ver static/js/sip.js). Se encolan y
  entregan desde un hilo propio para no bloquear nunca los hilos de PJSIP.
* ``SingleInstance``: una sola copia de la aplicación. Si se abre otra (por
  ejemplo desde un enlace ``tel:`` del CRM) le manda el número a la que ya
  está abierta y termina.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import socket
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from . import config
from .engine import EngineUnavailable, SipEngine

log = logging.getLogger("allemmsip.bridge")

_NUMBER_RE = re.compile(r"[^\d*#+]")


def number_from_argument(arg: str) -> str:
    """``tel:+52 (229) 512-5192`` / ``callto:2042`` / ``sip:2042@pbx`` → dígitos."""
    arg = (arg or "").strip().strip('"')
    if not arg or arg.startswith("-"):
        return ""
    low = arg.lower()
    for prefix in ("tel:", "callto:", "sip:", "sips:"):
        if low.startswith(prefix):
            arg = arg[len(prefix):]
            break
    arg = arg.split("@", 1)[0]
    arg = arg.replace("%2B", "+").replace("%20", "")
    cleaned = _NUMBER_RE.sub("", arg)
    # El "+" causa 404 en FreePBX; la interfaz también lo quita.
    return cleaned.lstrip("+")


class EventDispatcher:
    """Entrega eventos del motor a la ventana en orden y sin bloquear."""

    def __init__(self) -> None:
        self._q: "queue.Queue[tuple[str, dict]]" = queue.Queue()
        self._sink: Optional[Callable[[str], None]] = None
        self._listeners: list[Callable[[str, dict], None]] = []
        self._thread = threading.Thread(target=self._loop, name="ui-events", daemon=True)
        self._thread.start()

    def attach(self, evaluate_js: Callable[[str], None]) -> None:
        self._sink = evaluate_js

    def add_listener(self, fn: Callable[[str, dict], None]) -> None:
        self._listeners.append(fn)

    def __call__(self, name: str, data: dict) -> None:
        self._q.put((name, data))

    def _loop(self) -> None:
        while True:
            name, data = self._q.get()
            for fn in list(self._listeners):
                try:
                    fn(name, data)
                except Exception:  # noqa: BLE001
                    log.exception("Listener de eventos falló")
            sink = self._sink
            if sink is None:
                continue
            payload = json.dumps({"name": name, "data": data}, ensure_ascii=False)
            script = "window.AllemmBridge && window.AllemmBridge.dispatch(%s);" % payload
            try:
                sink(script)
            except Exception:  # noqa: BLE001
                log.debug("No se pudo entregar el evento %s a la ventana", name, exc_info=True)


class JsApi:
    """Métodos accesibles desde JavaScript: ``window.pywebview.api.<nombre>``."""

    def __init__(self, engine: SipEngine, settings: dict, dispatcher: EventDispatcher,
                 launch_number: str = ""):
        self._engine = engine
        self._settings = settings
        self._dispatcher = dispatcher
        self._launch_number = launch_number
        # OJO: debe ser privado (guion bajo). pywebview publica hacia JavaScript
        # todos los atributos públicos del API recorriéndolos de forma recursiva;
        # la ventana nativa (.NET Form) tiene atributos cíclicos y lo bloquea.
        self._window = None
        self._lock = threading.Lock()
        dispatcher.add_listener(self._on_engine_event)

    # ---- eventos del motor que requieren acción nativa ----------------------

    def _on_engine_event(self, name: str, data: dict) -> None:
        if name == "incoming_call":
            self.bring_to_front()

    def attach_window(self, window) -> None:
        self._window = window

    def bring_to_front(self) -> None:
        w = self._window
        if w is None:
            return
        try:
            w.restore()
        except Exception:  # noqa: BLE001
            pass
        try:
            w.on_top = True
            w.on_top = False
        except Exception:  # noqa: BLE001
            pass

    # ---- información y ajustes ----------------------------------------------

    def app_info(self) -> dict:
        return {
            "name": config.APP_NAME,
            "version": config.VERSION,
            "engineAvailable": SipEngine.available(),
            "engineError": SipEngine.import_error(),
            "dataDir": str(config.data_dir()),
            "platform": sys.platform,
        }

    def get_settings(self) -> dict:
        return dict(self._settings)

    def save_settings(self, values: dict) -> dict:
        with self._lock:
            self._settings = config.save_settings(values or {})
            self._engine.settings = config.engine_settings(self._settings)
            if self._engine.available():
                try:
                    self._engine.set_audio_devices(self._settings.get("captureDevice", ""),
                                                   self._settings.get("playbackDevice", ""))
                except Exception:  # noqa: BLE001
                    log.exception("No se pudieron aplicar los dispositivos de audio")
        return dict(self._settings)

    def list_audio_devices(self) -> list:
        try:
            return self._engine.list_audio_devices()
        except Exception as exc:  # noqa: BLE001
            log.warning("No se pudieron listar dispositivos: %s", exc)
            return []

    def engine_status(self) -> dict:
        try:
            return self._engine.snapshot()
        except Exception as exc:  # noqa: BLE001
            return {"registered": False, "inCall": False, "error": str(exc)}

    def get_launch_number(self) -> str:
        number, self._launch_number = self._launch_number, ""
        return number

    def push_launch_number(self, number: str) -> None:
        """Otra instancia nos mandó un número para marcar (enlace tel:)."""
        self._dispatcher("launch_number", {"number": number})
        self.bring_to_front()

    def open_log_folder(self) -> bool:
        path = config.data_dir()
        try:
            if os.name == "nt":
                os.startfile(str(path))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
            return True
        except Exception:  # noqa: BLE001
            return False

    # ---- motor SIP ----------------------------------------------------------

    def _guard(self, fn: Callable[[], Any], default: Any = False) -> Any:
        try:
            return fn()
        except EngineUnavailable as exc:
            log.error("%s", exc)
            self._dispatcher("engine_error", {"message": str(exc)})
            return default
        except Exception as exc:  # noqa: BLE001
            log.exception("Operación SIP falló")
            self._dispatcher("engine_error", {"message": str(exc)})
            return default

    def sip_register(self, extension: str, password: str, server: str = "") -> dict:
        if not self._engine.available():
            msg = "El motor SIP (pjsua2) no está compilado en esta instalación."
            self._dispatcher("registration_failed", {"cause": "Connection Error", "code": 0, "reason": msg})
            return {"ok": False, "error": msg}
        if server:
            # El login trae "host" o "host:puerto" (como el .exe anterior / MicroSIP).
            host, port = config.parse_server(server, int(self._settings.get("sipPort") or 5060))
            if not host:
                return {"ok": False, "cause": "BAD_SERVER", "error": "Servidor SIP inválido"}
            if host != self._settings.get("sipServer") or port != int(self._settings.get("sipPort") or 0):
                self.save_settings({"sipServer": host, "sipPort": port})

        def job():
            self._engine.register(str(extension), str(password))
            return {"ok": True}
        return self._guard(job, {"ok": False, "error": "engine"})

    def sip_unregister(self) -> bool:
        return self._guard(lambda: (self._engine.unregister(), True)[1])

    def sip_reconnect(self) -> bool:
        return self._guard(lambda: (self._engine.reconnect(), True)[1])

    def sip_network_changed(self) -> bool:
        return self._guard(lambda: (self._engine.network_changed(), True)[1])

    def sip_call(self, number: str) -> bool:
        return self._guard(lambda: self._engine.make_call(str(number)))

    def sip_answer(self) -> bool:
        return self._guard(self._engine.answer)

    def sip_hangup(self) -> bool:
        return self._guard(self._engine.hangup)

    def sip_toggle_mute(self) -> bool:
        return self._guard(self._engine.toggle_mute)

    def sip_hold(self, on: bool) -> bool:
        return self._guard(lambda: self._engine.hold(bool(on)))

    def sip_transfer(self, number: str) -> bool:
        return self._guard(lambda: self._engine.transfer(str(number)))

    def sip_dtmf(self, tone: str) -> bool:
        return self._guard(lambda: self._engine.send_dtmf(str(tone)))


class SingleInstance:
    """Una sola instancia por usuario, con paso de número entre instancias."""

    def __init__(self, on_number: Callable[[str], None], lock_dir: Optional[Path] = None):
        self._on_number = on_number
        self._dir = lock_dir or config.data_dir()
        self._port_file = self._dir / "instance.port"
        self._server: Optional[socket.socket] = None
        self.port = 0

    def try_acquire(self) -> bool:
        """True si somos la primera instancia (y quedamos escuchando)."""
        self._dir.mkdir(parents=True, exist_ok=True)
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            srv.bind(("127.0.0.1", 0))
            srv.listen(2)
        except OSError:
            srv.close()
            return False
        existing = self._read_port()
        if existing and self._ping(existing):
            srv.close()
            return False
        self._server = srv
        self.port = srv.getsockname()[1]
        self._port_file.write_text(str(self.port), encoding="utf-8")
        threading.Thread(target=self._serve, name="single-instance", daemon=True).start()
        return True

    def send_to_running(self, number: str) -> bool:
        port = self._read_port()
        if not port:
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as s:
                s.sendall(json.dumps({"number": number}).encode("utf-8") + b"\n")
                return s.recv(16).startswith(b"OK")
        except OSError:
            return False

    def release(self) -> None:
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
            self._server = None
        try:
            if self._port_file.exists() and self._port_file.read_text(encoding="utf-8").strip() == str(self.port):
                self._port_file.unlink()
        except OSError:
            pass

    def _read_port(self) -> int:
        try:
            return int(self._port_file.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            return 0

    def _ping(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
                s.sendall(b'{"ping":true}\n')
                return s.recv(16).startswith(b"OK")
        except OSError:
            return False

    def _serve(self) -> None:
        assert self._server is not None
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.settimeout(2)
                    raw = conn.makefile("rb").readline()
                    msg = json.loads(raw.decode("utf-8") or "{}")
                    number = number_from_argument(str(msg.get("number", "")))
                    if number:
                        self._on_number(number)
                    conn.sendall(b"OK\n")
                except Exception:  # noqa: BLE001
                    try:
                        conn.sendall(b"ERR\n")
                    except OSError:
                        pass
