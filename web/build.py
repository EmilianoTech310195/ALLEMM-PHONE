"""Arma la versión Web de ALLEMM SIP para subirla al servidor.

La versión Web es un proyecto propio (web/app): pantalla, motor JsSIP sobre
WSS + WebRTC y configuración del sitio (js/allemm-config.js). No comparte
código con el .exe ni con el APK. Se le agregan:
  - sw.js: service worker con la lista de archivos y su versión
  - monitor/ (recolector PHP + MySQL) y admin/ (panel): web/server

Uso:
    python web/build.py [carpeta_salida]        (por defecto dist/web)

La carpeta resultante se sube tal cual a un servidor con HTTPS.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "web" / "app"
SERVER = ROOT / "web" / "server"
SW_TEMPLATE = ROOT / "web" / "sw.template.js"
# Nunca se empaquetan: credenciales y datos del servidor.
SERVER_SKIP = {"monitor/db_config.php", "monitor/monitor_data.php", "monitor/monitor_data.php.lock"}


def copy_tree(src: Path, out: Path, skip: set[str] = frozenset()) -> None:
    for f in sorted(src.rglob("*")):
        rel = f.relative_to(src).as_posix()
        if f.is_file() and rel not in skip:
            dst = out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)


def build(out: Path) -> str:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    copy_tree(APP, out)

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

    copy_tree(SERVER, out, SERVER_SKIP)
    # GitHub Pages: no procesar con Jekyll (respeta carpetas y archivos tal cual).
    (out / ".nojekyll").write_text("", encoding="utf-8")
    return version


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "web"
    version = build(out.resolve())
    print(f"Versión Web lista en {out} (versión {version})")


if __name__ == "__main__":
    main()
