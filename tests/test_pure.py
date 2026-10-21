"""Pruebas que no necesitan pjsua2 compilado (lógica pura y configuración)."""

import json

import pytest

from allemmsip import config
from allemmsip.bridge import SingleInstance, number_from_argument
from allemmsip.engine import (
    call_failure_cause,
    pick_device,
    registration_cause,
    taken_by_colleague,
    uri_display,
    uri_user,
)


def test_uri_user_and_display():
    assert uri_user('"Juan Perez" <sip:2042@pbx.example.com>') == "2042"
    assert uri_user("sip:2295125192@pbx.example.com;transport=udp") == "2295125192"
    assert uri_user("<sips:1001@pbx>") == "1001"
    assert uri_display('"Juan Perez" <sip:2042@pbx>') == "Juan Perez"
    assert uri_display("sip:2042@pbx") == ""


@pytest.mark.parametrize("code,reason,status,expected", [
    (401, "Unauthorized", 0, "Authentication Error"),
    (407, "Proxy Authentication Required", 0, "Authentication Error"),
    (403, "Forbidden", 0, "Forbidden"),
    (408, "Request Timeout", 0, "Request Timeout"),
    (503, "Unable to resolve host", 70018, "Connection Error"),
    (503, "Service Unavailable", 0, "Service Unavailable"),
    (500, "Internal Server Error", 0, "Internal Server Error"),
    (0, "", 120011, "Connection Error"),
])
def test_registration_cause(code, reason, status, expected):
    assert registration_cause(code, reason, status) == expected


def test_call_failure_cause_mapping():
    assert call_failure_cause(486, local_hangup=False, incoming=False) == "Busy"
    assert call_failure_cause(404, local_hangup=False, incoming=False) == "Not Found"
    assert call_failure_cause(487, local_hangup=False, incoming=True) == "Canceled"
    # Saliente cancelada por el usuario → normal, sin alerta
    assert call_failure_cause(487, local_hangup=True, incoming=False) == "Canceled"
    # Entrante rechazada por el usuario → NO debe parecer "la tomó un compañero"
    assert call_failure_cause(603, local_hangup=True, incoming=True) == "Rejected"


def test_taken_by_colleague():
    cancel = "CANCEL sip:2042@10.0.0.5 SIP/2.0\r\nReason: SIP;cause=200;text=\"Call completed elsewhere\"\r\n"
    assert taken_by_colleague(487, cancel, incoming=True, local_hangup=False)
    assert taken_by_colleague(487, "", incoming=True, local_hangup=False)
    assert not taken_by_colleague(487, cancel, incoming=True, local_hangup=True)
    assert not taken_by_colleague(487, cancel, incoming=False, local_hangup=False)
    assert not taken_by_colleague(486, "", incoming=True, local_hangup=False)


def test_pick_device():
    devs = [
        {"id": 0, "name": "Micrófono (Realtek)", "inputCount": 1, "outputCount": 0},
        {"id": 1, "name": "Altavoces (Realtek)", "inputCount": 0, "outputCount": 2},
        {"id": 2, "name": "Headset (Jabra)", "inputCount": 1, "outputCount": 2},
    ]
    assert pick_device(devs, "", "capture") == -1
    assert pick_device(devs, "Headset (Jabra)", "capture") == 2
    assert pick_device(devs, "jabra", "playback") == 2
    assert pick_device(devs, "Altavoces (Realtek)", "capture") == -1  # no es entrada
    assert pick_device(devs, "no existe", "playback") == -1


@pytest.mark.parametrize("arg,expected", [
    ("2295125192", "2295125192"),
    ("tel:+52 (229) 512-5192", "522295125192"),
    ("callto:2042", "2042"),
    ("sip:2042@pbx.example.com", "2042"),
    ("TEL:%2B522295125192", "522295125192"),
    ("--headless", ""),
    ("", ""),
    ("*97", "*97"),
])
def test_number_from_argument(arg, expected):
    assert number_from_argument(arg) == expected


def test_settings_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("ALLEMMSIP_DATA_DIR", str(tmp_path))
    s = config.load_settings()
    assert s["sipServer"] == config.DEFAULTS["sipServer"]
    assert s["transport"] == "udp"
    saved = config.save_settings({"sipServer": " pbx.example.com ", "sipPort": "5062", "transport": "TCP",
                                  "dtmfMode": "rfc2833", "srtp": "bogus", "ignorado": 1})
    assert saved["sipServer"] == "pbx.example.com"
    assert saved["sipPort"] == 5062
    assert saved["transport"] == "tcp"
    assert saved["dtmfMode"] == "RFC2833"
    assert saved["srtp"] == "off"   # valor inválido → desactivado (como el PBX)
    assert "ignorado" not in saved
    again = config.load_settings()
    assert again["sipServer"] == "pbx.example.com"
    es = config.engine_settings(again)
    assert es.sip_port == 5062 and es.transport == "tcp" and es.dtmf_mode == "RFC2833"
    assert es.stun_servers == []  # como MicroSIP: sin STUN por defecto
    es2 = config.engine_settings(config.save_settings({"stunEnabled": True}))
    assert es2.stun_servers


def test_settings_seed_next_to_exe(tmp_path, monkeypatch):
    monkeypatch.setenv("ALLEMMSIP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(config, "app_dir", lambda: tmp_path)
    (tmp_path / "settings.json").write_text(json.dumps({"sipServer": "pbx.seed.com", "sipPort": 5062}), encoding="utf-8")
    s = config.load_settings()
    assert s["sipServer"] == "pbx.seed.com" and s["sipPort"] == 5062
    assert (tmp_path / "data" / "settings.json").exists()


def test_single_instance_handoff(tmp_path):
    received = []
    first = SingleInstance(received.append, lock_dir=tmp_path)
    assert first.try_acquire()
    second = SingleInstance(lambda n: None, lock_dir=tmp_path)
    assert not second.try_acquire()
    assert second.send_to_running("tel:+52 229 512 5192")
    for _ in range(50):
        if received:
            break
        import time
        time.sleep(0.05)
    assert received == ["522295125192"]
    first.release()
    third = SingleInstance(lambda n: None, lock_dir=tmp_path)
    assert third.try_acquire()
    third.release()


@pytest.mark.parametrize("text,expected", [
    ("pbx18879.pbxhosting.com.mx:49999", ("pbx18879.pbxhosting.com.mx", 49999)),
    ("  pbx.example.com ", ("pbx.example.com", 5060)),
    ("sip:pbx.example.com:5062;transport=udp", ("pbx.example.com", 5062)),
    ("[2001:db8::1]:5080", ("2001:db8::1", 5080)),
    ("pbx.example.com:abc", ("pbx.example.com", 5060)),
    ("", ("", 5060)),
])
def test_parse_server(text, expected):
    assert config.parse_server(text) == expected


def test_udp_timeout_falls_back_to_tcp_once():
    """Sin respuesta por UDP → un reintento por TCP; si TCP tampoco, falla."""
    from allemmsip.engine import EngineSettings, SipEngine

    eng = SipEngine(EngineSettings(sip_server="pbx.example.com", transport="udp", register_timeout=1))
    events, posted = [], []
    eng._emit = lambda name, data=None: events.append((name, data or {}))
    eng._post = lambda fn: posted.append(fn)
    eng._transports = {"udp": True, "tcp": True, "tls": False}

    eng._on_register_timeout()
    assert eng.settings.transport == "tcp"
    assert ("transport_fallback", {"from": "udp", "to": "tcp"}) in events
    assert posted and posted[0] == eng._register_job
    assert not any(n == "registration_failed" for n, _ in events)

    eng._on_register_timeout()          # TCP tampoco respondió
    assert any(n == "registration_failed" for n, _ in events)
    assert len(posted) == 1             # no vuelve a intentar en bucle


def test_no_fallback_when_disabled_or_not_udp():
    from allemmsip.engine import EngineSettings, SipEngine

    for st in (EngineSettings(transport="udp", auto_fallback_tcp=False), EngineSettings(transport="tcp")):
        eng = SipEngine(st)
        events = []
        eng._emit = lambda name, data=None, ev=events: ev.append(name)
        eng._post = lambda fn: (_ for _ in ()).throw(AssertionError("no debía reintentar"))
        eng._transports = {"udp": True, "tcp": True}
        eng._on_register_timeout()
        assert "registration_failed" in events


def test_timeout_after_auth_failure_is_flagged_as_ban():
    from allemmsip.engine import EngineSettings, SipEngine

    eng = SipEngine(EngineSettings(sip_server="pbx.example.com", transport="tcp"))
    events = []
    eng._emit = lambda name, data=None: events.append((name, data or {}))
    eng._on_reg_state(401, "Unauthorized", 300, 171100)
    assert events[-1][0] == "registration_failed" and events[-1][1]["cause"] == "Authentication Error"
    eng._on_reg_state(408, "Request Timeout", 300, 0)
    assert events[-1][1]["hint"] == "auth_ban"
    eng._on_register_timeout()
    assert events[-1][1]["hint"] == "auth_ban"


def test_failed_tcp_fallback_reverts_to_udp_and_success_is_saved():
    from allemmsip.engine import EngineSettings, SipEngine

    eng = SipEngine(EngineSettings(sip_server="pbx.example.com", transport="udp", register_timeout=1))
    events = []
    eng._emit = lambda name, data=None: events.append((name, data or {}))
    eng._post = lambda fn: None
    eng._transports = {"udp": True, "tcp": True}
    eng._on_register_timeout()                 # UDP sin respuesta → TCP
    assert eng.settings.transport == "tcp"
    eng._on_register_timeout()                 # TCP tampoco → vuelve a UDP, nada guardado
    assert eng.settings.transport == "udp"
    assert not any(n == "transport_saved" for n, _ in events)

    eng2 = SipEngine(EngineSettings(sip_server="pbx.example.com", transport="udp", register_timeout=1))
    ev2 = []
    eng2._emit = lambda name, data=None: ev2.append((name, data or {}))
    eng2._post = lambda fn: None
    eng2._transports = {"udp": True, "tcp": True}
    eng2._on_register_timeout()
    eng2._on_reg_state(200, "OK", 300, 0)      # registró por TCP → se guarda
    assert ("transport_saved", {"transport": "tcp"}) in ev2
    assert eng2.settings.transport == "tcp"


def test_account_identity_and_proxy_route():
    from allemmsip.engine import account_id_uri, proxy_route

    assert account_id_uri("2025", "pbx:49999") == "sip:2025@pbx:49999"
    assert account_id_uri("2025", "pbx:49999", 'Ana "Recepción"') == '"Ana Recepción" <sip:2025@pbx:49999>'
    srv = "sip:pbx:49999"
    assert proxy_route("", "udp", srv) == ""
    assert proxy_route("", "tcp", srv + ";transport=tcp") == "sip:pbx:49999;transport=tcp;lr"
    assert proxy_route("sbc.example.com:5080", "udp", srv) == "sip:sbc.example.com:5080;lr"
    assert proxy_route("sbc.example.com", "tcp", srv) == "sip:sbc.example.com;transport=tcp;lr"
    assert proxy_route("sip:sbc;transport=udp", "tcp", srv) == "sip:sbc;transport=udp;lr"


def test_stun_and_change_classification(tmp_path, monkeypatch):
    monkeypatch.setenv("ALLEMMSIP_DATA_DIR", str(tmp_path))
    s = config.load_settings()
    assert config.stun_list(s) == []
    s2 = config.save_settings({"stunEnabled": True, "stunServer": " stun.ejemplo.com ", "stunPort": "3479",
                               "voicemailNumber": "*97 abc", "authUser": " 2025a "})
    assert config.stun_list(s2) == ["stun.ejemplo.com:3479"]
    assert s2["voicemailNumber"] == "*97" and s2["authUser"] == "2025a"
    es = config.engine_settings(s2)
    assert es.stun_servers == ["stun.ejemplo.com:3479"] and es.auth_user == "2025a"
    ch = config.changed_keys(s, s2)
    assert {"stunEnabled", "stunServer", "stunPort"} <= ch
    assert any(k in config.RESTART_KEYS for k in ch)
    assert not any(k in config.REREGISTER_KEYS for k in config.changed_keys(s2, config.save_settings({"voicemailNumber": "123"})))
