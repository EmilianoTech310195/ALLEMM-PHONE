"""Punto de entrada de la aplicación de escritorio (AllemmSIP.exe).

Abre la interfaz en una ventana propia (pywebview sobre WebView2) y arranca
el motor SIP nativo (PJSIP). Sin navegador, sin WebSocket.

Uso:
    AllemmSIP.exe                     abre el softphone
    AllemmSIP.exe 2295125192          abre y marca ese número (click-to-call)
    AllemmSIP.exe tel:+522295125192   igual, desde enlaces tel:/callto:/sip:
    AllemmSIP.exe --headless          solo el motor, sin ventana (pruebas)
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time

from . import config
from .bridge import EventDispatcher, JsApi, SingleInstance, number_from_argument
from .engine import SipEngine

log = logging.getLogger("allemmsip.desktop")


def _parse(argv: list[str]) -> tuple[str, bool, bool]:
    number, headless, no_single = "", False, False
    for arg in argv:
        if arg == "--headless":
            headless = True
        elif arg == "--multi":
            no_single = True
        elif not arg.startswith("-"):
            number = number_from_argument(arg) or number
    return number, headless, no_single


def _fatal(message: str) -> None:
    print(message, file=sys.stderr)
    log.error(message)
    if os.name == "nt" and not os.environ.get("CI"):
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, config.APP_NAME, 0x10)
        except Exception:  # noqa: BLE001
            pass


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    settings = config.load_settings()
    log_path = config.setup_logging(bool(settings.get("debug")))
    try:
        return _run(argv, settings)
    except Exception:  # noqa: BLE001
        logging.exception("La aplicación falló al arrancar")
        _fatal(f"La aplicación falló al arrancar. Revisa el archivo {log_path}")
        return 1


def _run(argv: list[str], settings: dict) -> int:
    number, headless, no_single = _parse(argv)
    log.info("Arrancando %s %s (frozen=%s) args=%s", config.APP_NAME, config.VERSION,
             getattr(sys, "frozen", False), argv)

    dispatcher = EventDispatcher()
    engine = SipEngine(config.engine_settings(settings), dispatcher)
    api = JsApi(engine, settings, dispatcher, launch_number=number)

    single = None
    if not no_single and not headless:
        single = SingleInstance(api.push_launch_number)
        if not single.try_acquire():
            if number:
                single.send_to_running(number)
                log.info("Ya hay una instancia abierta; se le envió el número %s", number)
            else:
                single.send_to_running("")
                log.info("Ya hay una instancia abierta")
            return 0

    if engine.available():
        try:
            engine.start()
        except Exception as exc:  # noqa: BLE001
            log.exception("El motor SIP no pudo arrancar")
            _fatal("El motor SIP (PJSIP) no pudo arrancar.\n\nDetalle: " + str(exc))
            return 1
    else:
        log.error("pjsua2 no disponible: %s", engine.import_error())
        if headless:
            _fatal("pjsua2 no está compilado. Ejecuta tools\\build-pjsip-windows.ps1")
            return 1

    try:
        if headless:
            print(f"{config.APP_NAME} (sin ventana). Motor: {engine.snapshot()}")
            try:
                while True:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                pass
            return 0
        return _window(api, dispatcher, settings)
    finally:
        try:
            engine.stop()
        except Exception:  # noqa: BLE001
            log.exception("Error al apagar el motor")
        if single is not None:
            single.release()


def _window(api: JsApi, dispatcher: EventDispatcher, settings: dict) -> int:
    # WebView2 solo lee estos argumentos al crearse: permiten que el timbre y
    # el tono de llamada suenen sin un clic previo (política de autoplay).
    extra = "--autoplay-policy=no-user-gesture-required"
    prev = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    if extra not in prev:
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (prev + " " + extra).strip()

    try:
        import webview  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log.exception("No se pudo cargar pywebview")
        _fatal("No se pudo abrir la ventana de la aplicación. Instala Microsoft Edge WebView2 "
               "(https://developer.microsoft.com/microsoft-edge/webview2/) y vuelve a intentarlo.\n\n"
               f"Detalle: {exc}")
        return 1

    index = config.static_dir() / "index.html"
    if not index.exists():
        _fatal(f"No se encontró la interfaz en {index}")
        return 1

    data_dir = config.data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    title = f'{settings.get("appName") or "ALLEMM"} SIP'.strip()
    window = webview.create_window(
        title, str(index), js_api=api, width=1180, height=780, min_size=(900, 640),
        hidden=bool(settings.get("startMinimized")),
    )
    api.attach_window(window)
    dispatcher.attach(window.evaluate_js)

    def on_loaded():
        log.info("Interfaz cargada")

    try:
        window.events.loaded += on_loaded
    except Exception:  # noqa: BLE001
        pass

    start_kwargs = {"http_server": True, "private_mode": False, "storage_path": str(data_dir / "webview")}
    if settings.get("debug"):
        start_kwargs["debug"] = True
    try:
        webview.start(**start_kwargs)
    except TypeError:
        # pywebview antiguo sin storage_path/private_mode
        webview.start(http_server=True)
    log.info("Ventana cerrada")
    return 0


if __name__ == "__main__":
    sys.exit(main())
