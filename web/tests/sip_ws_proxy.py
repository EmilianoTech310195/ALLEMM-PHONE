"""Mini conmutador SIP sobre WebSocket (WSS) para probar la WebApp sin el PBX real.

- REGISTER con autenticación Digest (como FreePBX): 401 → 200.
- Enruta INVITE/ACK/BYE/CANCEL/INFO/re-INVITE entre los navegadores registrados.
- REFER (transferencia) lo acepta él mismo con 202, como hace Asterisk.
- Guarda cada mensaje en un JSONL para que la prueba revise lo que pasó.

Uso:  python sip_ws_proxy.py --port 8089 --cert cert.pem --key key.pem --log msgs.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import ssl
import time

import websockets

USERS = {"1001": "pw1001", "1002": "pw1002", "1003": "pw1003"}
REALM = "allemm-test"

aor: dict[str, object] = {}        # extensión → conexión
contacts: dict[str, object] = {}   # usuario del Contact (JsSIP lo inventa) → conexión
branches: dict[str, object] = {}   # branch del Via → conexión que mandó la petición
LOG = None


def log(direction: str, msg: str) -> None:
    first = msg.split("\r\n", 1)[0]
    LOG.write(json.dumps({"t": time.time(), "dir": direction, "first": first, "msg": msg}) + "\n")
    LOG.flush()


def parse(msg: str):
    head, _, body = msg.partition("\r\n\r\n")
    lines = head.split("\r\n")
    headers: dict[str, list[str]] = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers.setdefault(k.strip().lower(), []).append(v.strip())
    return lines[0], headers, body


def h(headers, name, default=""):
    return headers.get(name.lower(), [default])[0]


def uri_user(uri: str) -> str:
    m = re.search(r"sips?:([^@;>]+)@", uri)
    return m.group(1) if m else ""


def response(req_headers, code: int, reason: str, extra: str = "") -> str:
    out = [f"SIP/2.0 {code} {reason}"]
    for v in req_headers.get("via", []):
        out.append(f"Via: {v}")
    out.append(f"From: {h(req_headers, 'from')}")
    to = h(req_headers, "to")
    if code != 100 and ";tag=" not in to:
        to += ";tag=proxy" + hashlib.md5(h(req_headers, "call-id").encode()).hexdigest()[:8]
    out.append(f"To: {to}")
    out.append(f"Call-ID: {h(req_headers, 'call-id')}")
    out.append(f"CSeq: {h(req_headers, 'cseq')}")
    if extra:
        out.append(extra.rstrip("\r\n"))
    out.append("Content-Length: 0")
    return "\r\n".join(out) + "\r\n\r\n"


def digest_ok(auth: str, method: str) -> bool:
    p = dict(re.findall(r'(\w+)="?([^",]+)"?', auth))
    user = p.get("username", "")
    if user not in USERS:
        return False
    ha1 = hashlib.md5(f"{user}:{REALM}:{USERS[user]}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{method}:{p.get('uri', '')}".encode()).hexdigest()
    if p.get("qop"):
        expected = hashlib.md5(f"{ha1}:{p['nonce']}:{p['nc']}:{p['cnonce']}:{p['qop']}:{ha2}".encode()).hexdigest()
    else:
        expected = hashlib.md5(f"{ha1}:{p['nonce']}:{ha2}".encode()).hexdigest()
    return expected == p.get("response")


async def send(ws, msg: str, tag: str) -> None:
    log(tag, msg)
    try:
        await ws.send(msg)
    except Exception:  # noqa: BLE001
        pass


async def handle(ws):
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                msg = msg.decode()
            if msg.strip() == "":
                continue  # keep-alive CRLF
            log("in", msg)
            start, headers, _ = parse(msg)

            # Aprender el Contact de quien habla (para enrutar dentro del diálogo)
            for c in headers.get("contact", []) + headers.get("m", []):
                u = uri_user(c)
                if u:
                    contacts[u] = ws

            if start.startswith("SIP/2.0"):
                branch = re.search(r"branch=([^;,\s]+)", h(headers, "via"))
                dest = branches.get(branch.group(1)) if branch else None
                if dest is not None:
                    await send(dest, msg, "fwd-resp")
                continue

            method, ruri, _ = start.split(" ", 2)
            if method == "REGISTER":
                auth = h(headers, "authorization")
                if not auth or not digest_ok(auth, method):
                    nonce = hashlib.md5(str(time.time()).encode()).hexdigest()
                    await send(ws, response(headers, 401, "Unauthorized",
                                            f'WWW-Authenticate: Digest realm="{REALM}", nonce="{nonce}", algorithm=MD5, qop="auth"'),
                               "out")
                    continue
                user = uri_user(h(headers, "to"))
                contact = h(headers, "contact")
                expires = re.search(r"expires=(\d+)", contact) or None
                exp = int(expires.group(1)) if expires else int(h(headers, "expires", "600") or 600)
                if exp == 0:
                    aor.pop(user, None)
                else:
                    aor[user] = ws
                await send(ws, response(headers, 200, "OK", f"Contact: {contact};expires={exp}\r\nExpires: {exp}"), "out")
                continue

            if method == "REFER":
                await send(ws, response(headers, 202, "Accepted"), "out")
                continue

            user = uri_user(ruri)
            dest = contacts.get(user) if ".invalid" in ruri else aor.get(user)
            if dest is None:
                dest = aor.get(user) or contacts.get(user)
            if dest is None:
                if method != "ACK":
                    await send(ws, response(headers, 404, "Not Found"), "out")
                continue
            branch = re.search(r"branch=([^;,\s]+)", h(headers, "via"))
            if branch:
                branches[branch.group(1)] = ws
            await send(dest, msg, "fwd-req")
    finally:
        for table in (aor, contacts):
            for k in [k for k, v in table.items() if v is ws]:
                table.pop(k, None)


async def main() -> None:
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8089)
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    LOG = open(a.log, "w", encoding="utf-8")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    async with websockets.serve(handle, "127.0.0.1", a.port, ssl=ctx, subprotocols=["sip"]):
        print(f"proxy WSS en {a.port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
