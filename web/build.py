"""Arma la WebApp de ALLEMM SIP (PWA para iPhone y navegadores).

Toma la MISMA interfaz que el .exe y el APK (allemmsip/static) y le agrega:
  - el motor web (JsSIP sobre WSS + WebRTC): web/static/js/web-engine.js
  - js/allemm-config.js: conmutador y recolector (se edita en el servidor)
  - manifest, iconos y service worker para "Agregar a pantalla de inicio"
  - monitor/ (recolector PHP + MySQL) y admin/ (panel): web/server

Uso:
    python web/build.py [carpeta_salida]        (por defecto dist/web)

La carpeta resultante se sube tal cual a cualquier servidor HTTPS
(GitHub Pages, cPanel, Nginx...). Sin HTTPS el navegador bloquea el micrófono.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "allemmsip" / "static"
OVERLAY = ROOT / "web" / "static"
SW_TEMPLATE = ROOT / "web" / "sw.template.js"
# Monitoreo (PHP + MySQL) y panel de administración: van junto a la app.
SERVER = ROOT / "web" / "server"
# Nunca se empaquetan: credenciales y datos del servidor.
SERVER_SKIP = {"monitor/db_config.php", "monitor/monitor_data.php", "monitor/monitor_data.php.lock"}

# Solo sirven en el .exe / APK.
SKIP = {"js/android.js", "img/icon.ico"}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; "
    "connect-src 'self' wss: https:; worker-src 'self'; manifest-src 'self'; "
    "base-uri 'self'; form-action 'self'"
)

HEAD = f"""    <meta http-equiv="Content-Security-Policy" content="{CSP}">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="ALLEMM">
    <meta name="format-detection" content="telephone=no">
    <link rel="manifest" href="manifest.webmanifest">
    <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
    <link rel="stylesheet" href="css/web.css">
"""

ENGINE_SCRIPTS = """    <script src="js/allemm-config.js"></script>
    <script src="js/lib/jssip.min.js"></script>
    <script src="js/web-engine.js"></script>
    <script src="js/pwa.js"></script>
"""


def patch_index(html: str) -> str:
    def sub(pattern: str, repl: str, count: int = 1, flags: int = 0) -> str:
        nonlocal html
        new, n = re.subn(pattern, repl, html, count=count, flags=flags)
        if n == 0:
            raise SystemExit(f"build.py: no encontré en index.html: {pattern}")
        html = new
        return html

    sub(r'<meta name="viewport" content="[^"]*">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">')
    sub(r"\s*<!-- Aplicación de escritorio.*?-->", "", flags=re.S)
    sub(r'<meta name="description" content="[^"]*">',
        '<meta name="description" content="ALLEMM SIP - Softphone web">')
    sub(r'<meta name="theme-color" content="[^"]*">', '<meta name="theme-color" content="#0A0A0C">')
    sub(r"</head>", HEAD + "</head>")
    sub(r'\s*<script src="js/android.js"></script>\n', "\n")
    sub(r'(\s*)<script src="js/config.js"></script>',
        "\n" + ENGINE_SCRIPTS + r'    <script src="js/config.js"></script>')
    return html


def build(out: Path) -> str:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for src_root in (SHARED, OVERLAY):
        for f in sorted(src_root.rglob("*")):
            if not f.is_file():
                continue
            rel = f.relative_to(src_root).as_posix()
            if rel in SKIP:
                continue
            dst = out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)

    index = out / "index.html"
    index.write_text(patch_index(index.read_text(encoding="utf-8")), encoding="utf-8")

    files = sorted(p.relative_to(out).as_posix() for p in out.rglob("*")
                   if p.is_file() and not p.name.endswith(".txt") and p.name != "LICENSE")
    digest = hashlib.sha256()
    for rel in files:
        digest.update(rel.encode())
        digest.update((out / rel).read_bytes())
    version = digest.hexdigest()[:12]

    precache = ["./"] + [f for f in files if f != "index.html"] + ["index.html"]
    sw = SW_TEMPLATE.read_text(encoding="utf-8")
    sw = sw.replace("__VERSION__", version).replace("__FILES__", json.dumps(precache, indent=2))
    (out / "sw.js").write_text(sw, encoding="utf-8")
    for f in sorted(SERVER.rglob("*")):
        rel = f.relative_to(SERVER).as_posix()
        if f.is_file() and rel not in SERVER_SKIP:
            dst = out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
    # GitHub Pages: no procesar con Jekyll (respeta carpetas y archivos tal cual).
    (out / ".nojekyll").write_text("", encoding="utf-8")
    return version


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "web"
    version = build(out.resolve())
    print(f"WebApp lista en {out} (versión {version})")


if __name__ == "__main__":
    main()
