"""La compilación de la WebApp (web/build.py) arma una PWA válida."""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _build(tmp_path):
    out = tmp_path / "web"
    subprocess.run([sys.executable, str(ROOT / "web" / "build.py"), str(out)], check=True, capture_output=True)
    return out


def test_index_loads_web_engine_before_the_shared_ui(tmp_path):
    out = _build(tmp_path)
    html = (out / "index.html").read_text(encoding="utf-8")
    scripts = re.findall(r'<script src="([^"]+)"', html)
    assert "js/android.js" not in scripts
    assert scripts.index("js/lib/jssip.min.js") < scripts.index("js/web-engine.js") < scripts.index("js/sip.js")
    assert scripts[-1] == "js/app.js"
    assert 'rel="manifest"' in html and 'apple-touch-icon' in html and "viewport-fit=cover" in html
    assert "Content-Security-Policy" in html
    for src in scripts:
        assert (out / src).is_file(), src


def test_manifest_and_service_worker(tmp_path):
    out = _build(tmp_path)
    manifest = json.loads((out / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        assert (out / icon["src"]).is_file()
    sw = (out / "sw.js").read_text(encoding="utf-8")
    assert "__VERSION__" not in sw and "__FILES__" not in sw
    files = json.loads(re.search(r"const FILES = (\[.*?\]);", sw, re.S).group(1))
    for f in files:
        if f != "./":
            assert (out / f).is_file(), f
    assert not (out / "js" / "android.js").exists()
    assert (out / ".nojekyll").exists()


def test_build_version_is_stable(tmp_path):
    a = _build(tmp_path / "a")
    b = _build(tmp_path / "b")
    va = re.search(r"const VERSION = '(\w+)'", (a / "sw.js").read_text()).group(1)
    vb = re.search(r"const VERSION = '(\w+)'", (b / "sw.js").read_text()).group(1)
    assert va == vb   # misma entrada → misma versión (sin recargas innecesarias en los celulares)


def test_monitor_and_admin_are_packaged_without_secrets(tmp_path):
    secret = ROOT / "web" / "server" / "monitor" / "db_config.php"
    created = not secret.exists()
    if created:
        secret.write_text("<?php define('DB_PASS', 'secreto');", encoding="utf-8")
    try:
        out = _build(tmp_path)
    finally:
        if created:
            secret.unlink()
    assert (out / "monitor" / "collector.php").is_file()
    assert (out / "monitor" / "setup_db.php").is_file()
    assert (out / "admin" / "admin.html").is_file()
    assert not (out / "monitor" / "db_config.php").exists()
    sw = (out / "sw.js").read_text(encoding="utf-8")
    assert "monitor/" not in sw.split("const FILES")[1].split("];")[0]
    assert "admin/" not in sw.split("const FILES")[1].split("];")[0]


def test_site_config_loads_first_and_has_no_uvac_pbx(tmp_path):
    out = _build(tmp_path)
    html = (out / "index.html").read_text(encoding="utf-8")
    scripts = re.findall(r'<script src="([^"]+)"', html)
    assert scripts.index("js/allemm-config.js") < scripts.index("js/web-engine.js")
    for f in ("js/allemm-config.js", "js/web-engine.js"):
        assert "pbx18879" not in (out / f).read_text(encoding="utf-8")
