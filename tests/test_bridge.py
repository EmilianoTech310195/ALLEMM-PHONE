"""El puente JS ↔ motor, con un motor simulado (no necesita pjsua2)."""

import json
import threading
import time

from allemmsip import config
from allemmsip.bridge import EventDispatcher, JsApi
from allemmsip.engine import EngineUnavailable


class FakeEngine:
    def __init__(self, listener):
        self.listener = listener
        self.settings = None
        self.calls = []
        self.registered = False

    @staticmethod
    def available():
        return True

    @staticmethod
    def import_error():
        return ""

    def register(self, ext, password):
        self.calls.append(("register", ext, password))
        self.listener("registered", {})

    def unregister(self):
        self.calls.append(("unregister",))

    def reconnect(self):
        self.calls.append(("reconnect",))

    def network_changed(self):
        self.calls.append(("network",))

    def make_call(self, number):
        self.calls.append(("call", number))
        return True

    def answer(self):
        return True

    def hangup(self):
        return True

    def toggle_mute(self):
        return True

    def hold(self, on):
        return on

    def transfer(self, number):
        raise EngineUnavailable("apagado")

    def send_dtmf(self, tone):
        return tone == "1"

    def list_audio_devices(self):
        return [{"id": 0, "name": "Mic", "driver": "WASAPI", "inputCount": 1, "outputCount": 0}]

    _running = True

    def reconfigure(self, settings, restart=False, reregister=False):
        self.settings = settings
        return "restarted" if restart else "reregistered" if reregister else "saved"

    def available_transports(self):
        return {"udp": True, "tcp": True, "tls": False}

    def set_audio_devices(self, cap, play):
        self.calls.append(("devices", cap, play))

    def snapshot(self):
        return {"registered": self.registered, "inCall": False}


def _api(tmp_path, monkeypatch, launch=""):
    monkeypatch.setenv("ALLEMMSIP_DATA_DIR", str(tmp_path))
    dispatcher = EventDispatcher()
    scripts = []
    dispatcher.attach(scripts.append)
    engine = FakeEngine(dispatcher)
    api = JsApi(engine, config.load_settings(), dispatcher, launch_number=launch)
    return api, engine, scripts


def _wait(cond, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


def test_register_forwards_event_to_window(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)
    assert api.sip_register("2042", "pw") == {"ok": True}
    assert engine.calls[0] == ("register", "2042", "pw")
    assert _wait(lambda: scripts)
    assert "AllemmBridge.dispatch" in scripts[0]
    payload = json.loads(scripts[0].split("dispatch(", 1)[1].rsplit(")", 1)[0])
    assert payload == {"name": "registered", "data": {}}


def test_engine_errors_become_events_not_exceptions(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)
    assert api.sip_transfer("2001") is False
    assert _wait(lambda: any("engine_error" in s for s in scripts))
    assert api.sip_dtmf("1") is True
    assert api.sip_dtmf("5") is False
    assert api.sip_call("tel:2042") is True
    assert engine.calls[-1] == ("call", "tel:2042")


def test_settings_save_updates_engine(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)
    out = api.save_settings({"sipServer": "pbx.example.com", "transport": "tcp", "captureDevice": "Mic"})
    assert out["sipServer"] == "pbx.example.com"
    assert engine.settings.transport == "tcp"
    assert ("devices", "Mic", "") in engine.calls
    assert api.get_settings()["transport"] == "tcp"
    assert api.list_audio_devices()[0]["name"] == "Mic"


def test_launch_number_is_consumed_once_and_pushed(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch, launch="2042")
    assert api.get_launch_number() == "2042"
    assert api.get_launch_number() == ""
    api.push_launch_number("2001")
    assert _wait(lambda: any("launch_number" in s and "2001" in s for s in scripts))


def test_incoming_call_brings_window_to_front(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)

    class W:
        def __init__(self):
            self.restored = threading.Event()
            self.on_top = False

        def restore(self):
            self.restored.set()

    w = W()
    api.attach_window(w)
    engine.listener("incoming_call", {"caller": "2001"})
    assert w.restored.wait(3)
    assert api.app_info()["engineAvailable"] is True


def test_register_with_server_from_login_saves_settings(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)
    assert api.sip_register("2091", "pw", "pbx.example.com:49999") == {"ok": True}
    assert api.get_settings()["sipServer"] == "pbx.example.com"
    assert api.get_settings()["sipPort"] == 49999
    assert engine.settings.sip_server == "pbx.example.com" and engine.settings.sip_port == 49999
    assert engine.calls[-1] == ("register", "2091", "pw")
    bad = api.sip_register("2091", "pw", ":")
    assert bad["ok"] is False and bad["cause"] == "BAD_SERVER"


def test_api_has_no_public_non_callable_attributes(tmp_path, monkeypatch):
    """pywebview recorre los atributos públicos del API de forma recursiva:
    cualquier objeto público con referencias cíclicas (la ventana nativa)
    bloquea la aplicación. Solo métodos públicos."""
    api, engine, scripts = _api(tmp_path, monkeypatch)
    api.attach_window(object())
    for name in dir(api):
        if name.startswith("_"):
            continue
        assert callable(getattr(api, name)), f"atributo público no invocable en JsApi: {name}"


def test_save_settings_reports_how_it_was_applied(tmp_path, monkeypatch):
    api, engine, scripts = _api(tmp_path, monkeypatch)
    calls = []
    engine._running = True
    engine.reconfigure = lambda st, restart=False, reregister=False: (calls.append((restart, reregister)) or
                                                                      ("restarted" if restart else "reregistered" if reregister else "saved"))
    assert api.save_settings({"voicemailNumber": "*97"})["_applied"] == "saved"
    assert api.save_settings({"outboundProxy": "sbc.example.com"})["_applied"] == "reregistered"
    assert api.save_settings({"stunEnabled": True})["_applied"] == "restarted"
    assert calls == [(False, False), (False, True), (True, False)]
    assert api.app_info()["transports"]["udp"] is True
