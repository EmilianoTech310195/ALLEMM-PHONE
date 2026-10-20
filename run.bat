@echo off
rem Abre ALLEMM SIP desde el codigo fuente con el Python del sistema (sin entorno virtual).
rem Requisitos: Python 3.12 (64 bits), "pip install pywebview" y third_party\pjsua2\_pjsua2*.pyd
rem (compilado con tools\build-pjsip-windows.ps1 o copiado del artefacto "pjsua2-windows" de Actions).
cd /d "%~dp0"
python app.py --multi %*
