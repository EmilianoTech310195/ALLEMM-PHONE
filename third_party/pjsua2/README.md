# pjsua2 (PJSIP) para Python en Windows

Esta carpeta contiene lo necesario para que `import pjsua2` funcione en Windows
sin depender de ruedas de PyPI (no existen para Windows):

| Archivo | Qué es |
|---|---|
| `pjsua2_wrap.cpp` | Envoltorio generado con SWIG 4.2 a partir de `pjsip-apps/src/swig/pjsua2.i` de PJSIP 2.15.1. Es C++ portable: el mismo archivo sirve en Linux y Windows. |
| `pjsua2.py` | Parte Python del envoltorio (generada junto con el `.cpp`). |
| `setup_msvc.py` | Compila `pjsua2_wrap.cpp` con Visual Studio y lo enlaza con `libpjproject`. |
| `_pjsua2.pyd` | **Salida** (no se versiona). Lo produce `tools\build-pjsip-windows.ps1`. |
| `COPYING` | Licencia de PJSIP (GPL v2). |

## Cómo se compila

```powershell
# En la raíz del repositorio, con Visual Studio 2022 (C++) y Python 3.11+ instalados
.\tools\build-pjsip-windows.ps1
```

El script clona `pjproject` 2.15.1 en `third_party\pjproject`, compila
`libpjproject` en `Release-Dynamic` (CRT dinámico `/MD`, igual que CPython) y
después ejecuta `setup_msvc.py`, que genera `_pjsua2.cp3XX-win_amd64.pyd`.

La versión de Python usada para compilar debe ser la misma con la que se
empaqueta el `.exe` (PyInstaller). GitHub Actions usa Python 3.12.

## Si cambias de versión de PJSIP

Regenera el envoltorio con SWIG (`choco install swig`):

```powershell
python third_party\pjsua2\setup_msvc.py --pjdir third_party\pjproject --swig build_ext --inplace
```

## Licencia

PJSIP se distribuye bajo **GPL v2**. Al enlazar pjsua2, ALLEMM SIP queda
bajo GPL (igual que MicroSIP). Si se necesita distribuir sin GPL, Teluu vende
licencias comerciales de PJSIP.
