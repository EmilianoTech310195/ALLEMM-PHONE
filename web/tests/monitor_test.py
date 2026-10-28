"""Prueba del recolector + MySQL contra un servidor PHP real.

Uso:  python web/tests/monitor_test.py http://127.0.0.1:8100 <REPORT_TOKEN> <ADMIN_TOKEN>
(el sitio armado con web/build.py, con monitor/db_config.php apuntando a una base vacía)
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE, REP, ADM = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
COL = BASE + "/monitor/collector.php"
fails = 0


def check(cond, what):
    global fails
    print(("  ✔ " if cond else "  ✘ ") + what)
    if not cond:
        fails += 1


def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def get(params):
    return call("GET", COL + "?" + urllib.parse.urlencode(params))


def post(body):
    return call("POST", COL, body)


print("1. Instalador de la base")
code, html = call("GET", BASE + "/monitor/setup_db.php?token=malo")
check(code == 403, "token malo → 403")
code, html = call("GET", BASE + "/monitor/setup_db.php?token=" + urllib.parse.quote(ADM))
check(code == 200 and "Base de datos lista" in html, "setup_db crea tablas")

print("2. Tokens")
check(get({})[0] == 403, "sin token no lee")
check(get({"token": REP})[0] == 403, "el token de reporte NO lee")
check(post({"token": REP, "action": "set_config", "clave": "semaforo_verde", "valor": 1})[0] == 403,
      "el token de reporte NO edita")
check(post({"token": "x", "ext": "1001", "type": "conectado"})[0] == 403, "token falso no reporta")

print("3. Reportes de los teléfonos")
for ev in ({"ext": "1001", "type": "conectado"},
           {"ext": "1001", "type": "llamada_inicio", "number": "2295125192", "dir": "saliente"},
           {"ext": "1001", "type": "llamada_fin", "number": "2295125192", "dir": "saliente", "dur": 95},
           {"ext": "1002", "type": "llamada_fin", "number": "1001", "dir": "entrante", "dur": 30}):
    code, out = post(dict(ev, token=REP))
    check(code == 200 and json.loads(out)["ok"], f"{ev['ext']} {ev['type']}")
check(post({"token": REP, "ext": "1001", "type": "hack"})[0] == 400, "tipo desconocido → 400")

print("4. Panel")
live = json.loads(get({"token": ADM})[1])
check("1001" in live["online"], "1001 en línea")
check([e["type"] for e in live["events"]][-1] == "llamada_fin", "actividad en vivo")
calls = json.loads(get({"token": ADM, "report": "calls", "range": "today"})[1])["calls"]
check(len(calls) == 2 and {c["direccion"] for c in calls} == {"saliente", "entrante"}, "2 llamadas guardadas en MySQL")
check(post({"token": ADM, "action": "set_agent", "extension": "1001", "nombre": "Ana López",
            "meta_diaria": 2, "activo": 1})[0] == 200, "alta de agente con meta")
check(post({"token": ADM, "action": "set_agent", "extension": "10 01;", "nombre": "x"})[0] == 400, "extensión inválida → 400")
people = json.loads(get({"token": ADM, "report": "people", "range": "today"})[1])["people"]
ana = next(p for p in people if p["extension"] == "1001")
check(ana["nombre"] == "Ana López" and ana["total"] == 1 and ana["meta_total"] == 2 and ana["avance"] == 50,
      "por persona: nombre, total, meta y avance")
check(ana["semaforo"] == "rojo", "semáforo (50% < 60%)")
check(get({"token": ADM, "report": "calls", "range": "custom", "from": "2026-02-10", "to": "2026-02-01"})[0] == 400,
      "rango inválido → 400")
diag = json.loads(get({"token": ADM, "diag": "1"})[1])
check(diag["bd_conecta"] and diag["llamadas_guardadas"] == 2, "diagnóstico")
check(json.loads(get({"token": ADM, "reset": "presence"})[1])["ok"], "limpiar fantasmas")

print("\n" + (f"{fails} FALLA(S)" if fails else "TODO OK"))
sys.exit(1 if fails else 0)
