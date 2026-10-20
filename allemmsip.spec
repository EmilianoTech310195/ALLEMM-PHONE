# -*- mode: python ; coding: utf-8 -*-
# PyInstaller: `pyinstaller allemmsip.spec` genera dist/AllemmSIP/AllemmSIP(.exe)
# Necesita third_party/pjsua2/_pjsua2*.pyd (ver tools/build-pjsip-windows.ps1).
import glob
import os
import sys

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(".")
PJ = os.path.join(ROOT, "third_party", "pjsua2")

datas = [("allemmsip/static", "allemmsip/static")]
binaries, hiddenimports = [], ["pjsua2", "_pjsua2"]

# Módulo pjsua2 compilado (pyd/so) + su parte Python
for f in glob.glob(os.path.join(PJ, "_pjsua2*")):
    binaries.append((f, "."))
if os.path.exists(os.path.join(PJ, "pjsua2.py")):
    datas.append((os.path.join(PJ, "pjsua2.py"), "."))

# Ventana nativa (pywebview). En Windows usa pythonnet + WebView2.
try:
    d, b, h = collect_all("webview")
    datas += d; binaries += b; hiddenimports += h
    hiddenimports += ["webview.platforms.winforms", "webview.platforms.edgechromium", "bottle"]
    if sys.platform == "win32":
        for pkg in ("clr_loader", "pythonnet"):
            d, b, h = collect_all(pkg)
            datas += d; binaries += b; hiddenimports += h
        hiddenimports += ["clr"]
except Exception as exc:  # pywebview no instalado: solo --headless
    print("AVISO: pywebview no disponible:", exc)

a = Analysis(
    ["app.py"],
    pathex=[ROOT, PJ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "PIL", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
icon = os.path.join(ROOT, "allemmsip", "static", "img", "icon.ico")
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="AllemmSIP",
    console=False if sys.platform == "win32" else True,
    icon=icon if (sys.platform == "win32" and os.path.exists(icon)) else None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="AllemmSIP")
