# ALLEMM SIP — softphone de escritorio (.exe) 📞

Cliente SIP para Windows al estilo **MicroSIP**: habla SIP **por UDP, TCP o
TLS directo con el PBX** (sin WebSocket ni navegador) y usa la tarjeta de
sonido de la PC. Conserva la interfaz del softphone web (marcador,
historial, notas, transferencia, identificador de país) y le cambia el motor:
**JsSIP + WebRTC → PJSIP (pjsua2)**, la misma librería que usa MicroSIP.

| Pieza | Herramienta |
|---|---|
| Motor SIP y audio | [PJSIP 2.15.1](https://www.pjsip.org) vía `pjsua2` (Python) — UDP/TCP/TLS, SRTP, DTMF RFC 2833 e INFO, hold, transferencia |
| Interfaz | HTML/CSS/JS original del softphone web, en una ventana [pywebview](https://pywebview.flowrl.com) sobre WebView2 |
| Ejecutable e instalador | [PyInstaller](https://pyinstaller.org) + [Inno Setup](https://jrsoftware.org/isinfo.php) + GitHub Actions |

## Instalar (usuarios)

Descarga **`AllemmSIP-Setup.exe`** desde *Releases* (o desde *Actions →
Compilar AllemmSIP.exe → Artifacts*) y ejecútalo. La primera vez abre
**Ajustes** y captura el servidor SIP (PBX), puerto y transporte; después
entra con tu extensión y contraseña SIP, las mismas de siempre.

También hay una versión portable (`AllemmSIP-portable.zip`).

### Click-to-call

- `AllemmSIP.exe 2295125192` abre el teléfono y marca.
- El instalador registra los enlaces `tel:`, `callto:` y `sip:`; un clic en
  `tel:+522295125192` en el navegador o el CRM marca en la app (si ya está
  abierta, se le pasa el número; solo corre una instancia).

### Instalación masiva

Deja un `settings.json` junto a `AllemmSIP.exe` con, por ejemplo:

```json
{ "sipServer": "pbx.midominio.com", "sipPort": 5060, "transport": "udp", "dtmfMode": "INFO" }
```

La primera vez que arranca, la app lo copia como configuración del usuario
(`%LOCALAPPDATA%\AllemmSIP\settings.json`). Ahí mismo queda el log
(`allemmsip.log`), accesible con el botón *Logs* de Ajustes.

## Compilar en tu PC (Visual Studio + consola)

Requisitos: **Visual Studio 2022** con *Desarrollo de escritorio con C++*,
**Python 3.11+** 64 bits (en PATH), **Git** y, para el instalador,
[Inno Setup 6](https://jrsoftware.org/isdl.php).

```powershell
git clone https://github.com/EmilianoTech310195/ALLEMM-PHONE.git
cd ALLEMM-PHONE
.\build-windows.ps1
```

`build-windows.ps1` hace todo: crea el `.venv`, **compila PJSIP y el módulo
`pjsua2` con MSVC** (`tools\build-pjsip-windows.ps1`, solo la primera vez,
5-10 min), corre las pruebas, genera `dist\AllemmSIP\AllemmSIP.exe` y, si
hay Inno Setup, `installer-out\AllemmSIP-Setup.exe`.

Para desarrollar sin empaquetar:

```powershell
.\.venv\Scripts\Activate.ps1
python app.py              # abre la ventana
python app.py --headless   # solo el motor (sin ventana)
python -m pytest -q        # pruebas (incluye llamadas SIP reales en 127.0.0.1)
```

GitHub Actions compila lo mismo en cada push (`.github/workflows/build-windows.yml`)
y publica una *Release* al etiquetar `v*`.

## Estructura

```
app.py                      ← lanzador
allemmsip/
  desktop.py                ← ventana (pywebview), argumentos, instancia única
  engine.py                 ← MOTOR SIP (pjsua2): registro, llamadas, DTMF, mute, hold, transferencia
  bridge.py                 ← API window.pywebview.api ↔ motor; eventos hacia la interfaz
  config.py                 ← settings.json, carpeta de datos, logs
  static/                   ← interfaz (del softphone web)
    js/sip.js               ← NUEVO: mismo contrato UvacSIP, pero habla con Python
    js/settings.js          ← NUEVO: modal de Ajustes (servidor, audio, DTMF)
    js/app.js, alerts.js, caller-id.js, ringback.js, reporter.js, config.js
    vendor/tabler/          ← iconos en local (sin CDN)
third_party/pjsua2/         ← envoltorio SWIG de pjsua2 + setup_msvc.py (compila el .pyd)
tools/build-pjsip-windows.ps1
allemmsip.spec, build-windows.ps1, installer/AllemmSIP.iss
tests/                      ← pruebas puras, del puente y de llamadas reales (dos motores por UDP)
```

## Qué cambió respecto al softphone web

| | Web (uvacSIP Web) | Escritorio (ALLEMM SIP) |
|---|---|---|
| Transporte SIP | WSS (WebSocket) 8089 | **UDP / TCP / TLS** (configurable) |
| Audio | WebRTC del navegador | **PJSIP** con WASAPI, selección de micrófono y altavoz |
| Motor | `js/sip.js` + JsSIP 3.10 | `allemmsip/engine.py` (pjsua2) + `js/sip.js` puente |
| Interfaz | igual | igual (más el modal de Ajustes) |
| Ocupado con 2.ª llamada | 486 Busy | 486 Busy |
| "La tomó un compañero" | Reason / Canceled | Reason: cause=200 / 487 |
| DTMF | INFO o RFC2833 | INFO o RFC2833 |
| Reintentos de registro | manual + contador | automáticos de PJSIP (408/5xx) + botón Reintentar |
| Panel de monitoreo | `monitor/collector.php` | opcional: URL y token en Ajustes |
| Instalación | ninguna | instalador o portable; enlaces `tel:` |

Los archivos `admin/`, `monitor/` y `widget.html` del proyecto web son de
servidor y no forman parte del `.exe`.

## Licencia

PJSIP es **GPL v2**; al enlazarlo, este programa se distribuye bajo GPL
(igual que MicroSIP). Ver `third_party/pjsua2/COPYING`.
