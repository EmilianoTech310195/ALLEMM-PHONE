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
Compilar AllemmSIP.exe → Artifacts*) y ejecútalo. La pantalla de inicio es
la misma del `.exe` anterior: **Servidor SIP** (`host:puerto`, viene
precargado), **Extensión** y **Contraseña**. Son los mismos datos que en
MicroSIP: servidor y dominio con puerto, transporte UDP, sin cifrado ni ICE,
registro cada 300 s. En **Ajustes** se puede cambiar transporte, micrófono,
altavoz y modo DTMF.

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

Para correrlo desde el código **sin entorno virtual** (Python 3.12 de 64 bits
instalado con "Add to PATH"):

```powershell
pip install pywebview pytest
# El módulo pjsua2 compilado: o lo compilas (tools\build-pjsip-windows.ps1, requiere
# Visual Studio) o bajas el artefacto "pjsua2-windows-py312" de Actions y copias
# _pjsua2.cp312-win_amd64.pyd y pjsua2.py en third_party\pjsua2\
python app.py          # o doble clic en run.bat, o F5 en VS Code
```

Para desarrollar con entorno virtual:

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
| Audio | WebRTC del navegador | **PJSIP** (WMME de Windows), selección de micrófono y altavoz |
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

## Firma digital (SmartScreen y antivirus)

Un `.exe` sin firma hecho con PyInstaller dispara SmartScreen y a veces el
antivirus. Para evitarlo se firma el ejecutable y el instalador en GitHub
Actions. El flujo ya trae el paso: solo hay que crear dos *secrets* en el
repositorio (*Settings → Secrets and variables → Actions*):

| Secret | Contenido |
|---|---|
| `CODESIGN_PFX_BASE64` | el certificado `.pfx` codificado en base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
| `CODESIGN_PFX_PASSWORD` | la contraseña del `.pfx` |

Dónde conseguir el certificado: **Azure Trusted Signing** (Microsoft, ~10 USD/mes,
reputación inmediata en SmartScreen), o un certificado **OV/EV** de DigiCert,
Sectigo, GlobalSign, etc. Mientras no haya certificado, el instalador funciona
igual pero Windows mostrará "Más información → Ejecutar de todas formas".

El instalador además registra la regla del **Firewall de Windows** para
`AllemmSIP.exe` (entrada y salida), para que las respuestas SIP y el audio
RTP no se bloqueen en ninguna PC. Por eso pide permisos de administrador.

## Android (APK de pruebas)

La carpeta `android/` es la app para celular. Usa **la misma interfaz**
(`allemmsip/static`, empaquetada dentro del APK) y **el mismo motor PJSIP**,
reescrito en Kotlin (`SipEngine.kt`, traducción directa de `engine.py`).
Habla SIP por UDP/TCP con el PBX igual que el `.exe`: sin WebSocket y sin
servicios de notificaciones de terceros.

| Pieza | Archivo |
|---|---|
| Motor SIP (pjsua2) | `android/app/src/main/java/com/allemm/sip/SipEngine.kt` |
| Servicio que mantiene la extensión registrada, timbre, notificación de llamada, audio | `SipService.kt` |
| Puente interfaz ↔ motor (`window.AllemmAndroid`) | `JsBridge.kt` + `allemmsip/static/js/android.js` |
| Pantalla (WebView) | `MainActivity.kt` |
| Compilar PJSIP con el NDK | `tools/build-pjsip-android.sh` |

**Descargar:** GitHub → *Actions* → *Compilar APK Android* → *Artifacts* →
`AllemmSIP-android`. En el teléfono: abrir el `.apk`, permitir "instalar apps
desconocidas" para el navegador o el administrador de archivos, instalar.

**Primer uso:** aceptar micrófono y notificaciones, y cuando lo pida, permitir
que la app **no se optimice la batería**. Sin eso Android la duerme con la
pantalla apagada y deja de recibir llamadas. En Xiaomi, Huawei, Oppo y Samsung
además conviene activar "Inicio automático" / "Sin restricciones" para ALLEMM SIP.

**Comportamiento:**
- La extensión queda registrada en segundo plano (notificación fija "En línea").
- Llamada entrante: suena con el timbre del teléfono, vibra y muestra la pantalla
  de llamada aunque esté bloqueado, con *Contestar* y *Rechazar*.
- En llamada: auricular por defecto, botón de altavoz, la pantalla se apaga al
  acercarla a la oreja.
- Si cambia la red (WiFi ↔ datos), vuelve a registrar sola.
- Enlaces `tel:` y `sip:` abren la app y marcan (click-to-call).
- *Ajustes → Logs* comparte el `allemmsip.log` (WhatsApp, correo…).
- Atrás manda la app al fondo; para salir de verdad: notificación → *Salir*.

**Firma:** el APK de pruebas se firma con una llave de pruebas guardada en la
caché de GitHub Actions, para poder instalar versiones nuevas encima. Si un
día Android dice "app no instalada" al actualizar, desinstala la anterior una
vez. Antes de repartirla en serio hay que crear una llave definitiva.

**Compilar en tu PC** (Linux, macOS o WSL, con Android Studio/SDK, NDK, SWIG y JDK 17):

```bash
bash tools/build-pjsip-android.sh      # una vez: PJSIP para Android
cd android && ./gradlew assembleRelease
```
