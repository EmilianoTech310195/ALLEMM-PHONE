"""Prueba de integración REAL del motor con PJSIP.

"Alice" corre en este proceso; "Bob" (y "Carol") corren como subprocesos
(tests/sip_peer.py) porque pjsua2 solo admite un Endpoint por proceso. Se
llaman por UDP en 127.0.0.1, sin PBX y sin tarjeta de sonido.

Se omite automáticamente si pjsua2 no está compilado.
"""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from allemmsip.engine import EngineSettings, SipEngine, wait_for

pytestmark = pytest.mark.skipif(not SipEngine.available(), reason="pjsua2 no está compilado")

ROOT = Path(__file__).resolve().parent.parent


class Recorder:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, name, data):
        with self.lock:
            self.events.append((name, data))

    def has(self, name):
        with self.lock:
            return any(n == name for n, _ in self.events)

    def get(self, name):
        with self.lock:
            return next((d for n, d in self.events if n == name), None)

    def count(self, name):
        with self.lock:
            return sum(1 for n, _ in self.events if n == name)


class Peer:
    """Motor SIP en un subproceso (ver sip_peer.py)."""

    def __init__(self, name):
        env = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, str(ROOT / "tests" / "sip_peer.py"), name],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, env=env, cwd=str(ROOT))
        self.rec = Recorder()
        self.port = 0
        self.results = []
        self._ready = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()
        assert self._ready.wait(30), "el par SIP no arrancó"

    def _reader(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("ready"):
                self.port = msg["port"]
                self._ready.set()
            elif "event" in msg:
                self.rec(msg["event"], msg.get("data", {}))
            elif "result" in msg:
                self.results.append(msg)

    def send(self, cmd):
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def uri(self, user):
        return f"sip:{user}@127.0.0.1:{self.port}"

    def close(self):
        try:
            self.send("quit")
            self.proc.wait(timeout=20)
        except Exception:  # noqa: BLE001
            self.proc.kill()


@pytest.fixture
def alice():
    rec = Recorder()
    eng = SipEngine(EngineSettings(sip_server="127.0.0.1", transport="udp", stun_servers=[], srtp="off",
                                   user_agent="test-alice", log_level=2), rec)
    eng.start()
    eng.use_null_audio()
    eng.add_local_account("alice")
    yield eng, rec
    eng.stop()


@pytest.fixture
def bob():
    p = Peer("bob")
    yield p
    p.close()


def test_call_answer_dtmf_mute_hangup(alice, bob):
    a, ra = alice
    assert a.call_direct(bob.uri("bob"))
    assert wait_for(lambda: bob.rec.has("incoming_call"), 15), bob.rec.events
    assert bob.rec.get("incoming_call")["caller"] == "alice"
    assert wait_for(lambda: ra.has("call_progress"), 10), ra.events
    assert a.in_call

    bob.send("answer")
    assert wait_for(lambda: ra.has("call_answered") and bob.rec.has("call_answered"), 15), (ra.events, bob.rec.events)
    assert a.call_established

    assert a.toggle_mute() is True and a.muted
    assert a.toggle_mute() is False
    assert a.send_dtmf("1")
    a.settings.dtmf_mode = "RFC2833"
    assert a.send_dtmf("2#")
    snap = a.snapshot()
    assert snap["inCall"] and snap["established"] and not snap["incoming"]

    assert a.hangup()
    assert wait_for(lambda: ra.has("call_ended") and bob.rec.has("call_ended"), 15), (ra.events, bob.rec.events)
    assert not a.in_call


def test_second_incoming_call_gets_busy(alice, bob):
    a, ra = alice
    carol = Peer("carol")
    try:
        assert a.call_direct(bob.uri("bob"))
        assert wait_for(lambda: bob.rec.has("incoming_call"), 15)
        # Carol llama a Bob mientras Bob sigue sonando con Alice → 486 Busy
        carol.send("call " + bob.uri("bob"))
        assert wait_for(lambda: carol.rec.has("call_failed"), 15), carol.rec.events
        assert carol.rec.get("call_failed")["cause"] == "Busy"
        time.sleep(0.5)
        assert bob.rec.count("incoming_call") == 1
        # Bob rechaza a Alice: Bob NO debe ver "la tomó un compañero"
        bob.send("hangup")
        assert wait_for(lambda: ra.has("call_failed") and bob.rec.has("call_failed"), 15), (ra.events, bob.rec.events)
        assert bob.rec.get("call_failed")["taken_by_colleague"] is False
        assert bob.rec.get("call_failed")["cause"] == "Rejected"
        assert ra.get("call_failed")["cause"] in ("Rejected", "Busy")
    finally:
        carol.close()


def test_caller_cancels_before_answer(alice, bob):
    a, ra = alice
    assert a.call_direct(bob.uri("bob"))
    assert wait_for(lambda: bob.rec.has("incoming_call"), 15)
    assert a.hangup()
    assert wait_for(lambda: ra.has("call_failed") and bob.rec.has("call_failed"), 15), (ra.events, bob.rec.events)
    # Quien llamó: cancelada por él mismo (normal). Quien recibía: el otro lado
    # canceló → en un grupo de timbrado eso es "la tomó un compañero".
    assert ra.get("call_failed")["cause"] == "Canceled"
    assert bob.rec.get("call_failed")["cause"] == "Canceled"
    assert bob.rec.get("call_failed")["taken_by_colleague"] is True


def test_register_against_nothing_reports_failure():
    rec = Recorder()
    eng = SipEngine(EngineSettings(sip_server="127.0.0.1", sip_port=1, transport="udp", stun_servers=[],
                                   register_timeout=4, retry_delay=60, log_level=2), rec)
    eng.start()
    eng.use_null_audio()
    try:
        eng.register("1001", "secret")
        assert wait_for(lambda: rec.has("registration_failed"), 40), rec.events
        cause = rec.get("registration_failed")["cause"]
        assert cause in ("Connection Error", "Request Timeout", "Connection Timeout", "Service Unavailable")
        assert not eng.is_registered
        eng.unregister()
    finally:
        eng.stop()


def test_only_one_engine_per_process(alice):
    other = SipEngine(EngineSettings(sip_server="127.0.0.1"), lambda n, d: None)
    with pytest.raises(RuntimeError):
        other.start()


def test_audio_devices_listing(alice):
    a, _ = alice
    devs = a.list_audio_devices()
    assert isinstance(devs, list)
    for d in devs:
        assert {"id", "name", "inputCount", "outputCount"} <= set(d)
