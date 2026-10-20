"""Compila el módulo Python ``pjsua2`` (``_pjsua2.pyd``) con Visual Studio.

PJSIP no publica ruedas de pjsua2 para Windows, y su ``setup.py`` oficial
solo funciona con make/MinGW. Este script hace lo equivalente con MSVC:

  1. Usa ``pjsua2_wrap.cpp`` (ya generado con SWIG, incluido en esta carpeta;
     si tienes SWIG instalado y quieres regenerarlo: ``--swig``).
  2. Lo compila contra las cabeceras de pjproject y lo enlaza con la
     biblioteca ``libpjproject-*-Release-Dynamic.lib`` que produce
     ``msbuild pjproject-vs14.sln /t:libpjproject /p:Configuration=Release-Dynamic``.
  3. Deja ``_pjsua2.pyd`` + ``pjsua2.py`` en esta carpeta (o donde diga
     ``--dest``), listos para ``import pjsua2`` y para PyInstaller.

Uso (desde "x64 Native Tools Command Prompt" o PowerShell con MSVC en PATH):

    python setup_msvc.py build_ext --inplace
    python setup_msvc.py --pjdir C:\\ruta\\pjproject build_ext --inplace

Variables de entorno reconocidas: PJDIR (ruta a pjproject), PJ_CONFIG
(Release-Dynamic por defecto).
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _arg(name: str, default: str) -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        value = sys.argv[i + 1]
        del sys.argv[i:i + 2]
        return value
    return default


def main() -> None:
    pjdir = Path(_arg("--pjdir", os.environ.get("PJDIR", str(HERE.parent / "pjproject")))).resolve()
    pjconfig = _arg("--config", os.environ.get("PJ_CONFIG", "Release-Dynamic"))
    dest = Path(_arg("--dest", str(HERE))).resolve()
    regenerate = "--swig" in sys.argv
    if regenerate:
        sys.argv.remove("--swig")

    if not (pjdir / "pjlib" / "include" / "pj" / "config.h").exists():
        sys.exit(f"No encuentro pjproject en {pjdir}. Usa --pjdir o la variable PJDIR.")

    if regenerate:
        _run_swig(pjdir)

    libs = sorted(glob.glob(str(pjdir / "lib" / f"libpjproject-*-{pjconfig}.lib")))
    if not libs:
        sys.exit(
            f"No hay libpjproject-*-{pjconfig}.lib en {pjdir / 'lib'}. Compila primero:\n"
            f'  msbuild "{pjdir / "pjproject-vs14.sln"}" /t:libpjproject /p:Configuration={pjconfig} /p:Platform=x64'
        )
    lib = libs[0]
    print("Enlazando con", lib)

    from setuptools import Extension, setup

    include_dirs = [str(pjdir / d / "include") for d in ("pjlib", "pjlib-util", "pjnath", "pjmedia", "pjsip")]
    windows_libs = ["ws2_32", "wsock32", "ole32", "dsound", "dxguid", "netapi32", "mswsock",
                    "odbc32", "user32", "gdi32", "advapi32", "winmm", "iphlpapi", "crypt32"]
    ext = Extension(
        "_pjsua2",
        sources=[str(HERE / "pjsua2_wrap.cpp")],
        include_dirs=include_dirs,
        define_macros=[("PJ_WIN32", "1"), ("PJ_M_X86_64", "1"), ("PJ_IS_LITTLE_ENDIAN", "1"),
                       ("PJ_IS_BIG_ENDIAN", "0"), ("_CRT_SECURE_NO_WARNINGS", "1")],
        extra_compile_args=["/EHsc", "/MD", "/O2", "/bigobj", "/wd4244", "/wd4267", "/utf-8"],
        extra_objects=[lib],
        libraries=windows_libs,
    )
    os.chdir(HERE)
    setup(name="pjsua2", version="2.15.1", description="PJSUA2 (PJSIP) para Python, compilado con MSVC",
          ext_modules=[ext], py_modules=["pjsua2"], script_args=sys.argv[1:] or ["build_ext", "--inplace"])

    if dest != HERE:
        dest.mkdir(parents=True, exist_ok=True)
        for f in glob.glob(str(HERE / "_pjsua2*.pyd")) + [str(HERE / "pjsua2.py")]:
            shutil.copy2(f, dest)
            print("Copiado", f, "->", dest)


def _run_swig(pjdir: Path) -> None:
    swig = shutil.which("swig")
    if not swig:
        sys.exit("SWIG no está en PATH (choco install swig) — o quita --swig para usar el wrap incluido")
    inc = [f"-I{pjdir / d / 'include'}" for d in ("pjlib", "pjlib-util", "pjmedia", "pjsip", "pjnath")]
    cmd = [swig, *inc, "-c++", "-w312", "-threads", "-doxygen", "-python",
           "-o", str(HERE / "pjsua2_wrap.cpp"), str(pjdir / "pjsip-apps" / "src" / "swig" / "pjsua2.i")]
    print(" ".join(cmd))
    subprocess.check_call(cmd, cwd=str(pjdir / "pjsip-apps" / "src" / "swig" / "python"))
    gen_py = pjdir / "pjsip-apps" / "src" / "swig" / "python" / "pjsua2.py"
    if gen_py.exists():
        shutil.copy2(gen_py, HERE / "pjsua2.py")


if __name__ == "__main__":
    main()
