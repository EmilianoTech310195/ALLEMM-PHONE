"""Par SIP de pruebas en un proceso aparte.

pjsua2 solo permite UN Endpoint por proceso, así que para probar una llamada
real entre dos motores el segundo corre aquí, como subproceso:

    stdout → una línea JSON por evento: {"event": "...", "data": {...}}
             (la primera línea es {"ready": true, "port": N})
    stdin  → comandos: answer | hangup | mute | call <uri> | quit
"""

import json
import sys
import threading

from allemmsip.engine import EngineSettings, SipEngine

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "peer"
    eng = SipEngine(EngineSettings(sip_server="127.0.0.1", transport="udp", stun_servers=[], srtp="off",
                                   user_agent=f"peer-{name}", log_level=2),
                    lambda n, d: emit({"event": n, "data": d}))
    eng.start()
    eng.use_null_audio()
    eng.add_local_account(name)
    emit({"ready": True, "port": eng.local_port()})
    try:
        for line in sys.stdin:
            cmd = line.strip().split(" ", 1)
            if not cmd or not cmd[0]:
                continue
            if cmd[0] == "answer":
                emit({"result": "answer", "ok": eng.answer()})
            elif cmd[0] == "hangup":
                emit({"result": "hangup", "ok": eng.hangup()})
            elif cmd[0] == "mute":
                emit({"result": "mute", "ok": eng.toggle_mute()})
            elif cmd[0] == "call" and len(cmd) > 1:
                emit({"result": "call", "ok": eng.call_direct(cmd[1].strip())})
            elif cmd[0] == "quit":
                break
    finally:
        eng.stop()


if __name__ == "__main__":
    main()
