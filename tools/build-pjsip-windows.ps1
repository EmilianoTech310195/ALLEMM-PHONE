# Compila PJSIP 2.15.1 con Visual Studio y genera el módulo Python pjsua2
# (third_party\pjsua2\_pjsua2.pyd) que usa ALLEMM SIP.
#
# Requisitos (una sola vez):
#   - Visual Studio 2022 (Community sirve) con "Desarrollo de escritorio con C++"
#     y el SDK de Windows 10/11.   https://visualstudio.microsoft.com/es/vs/community/
#   - Python 3.11+ de python.org (64 bits), con "Add python.exe to PATH".
#   - Git.
#
# Uso (PowerShell, en la raíz del repositorio):
#   .\tools\build-pjsip-windows.ps1
#
# Resultado: third_party\pjsua2\_pjsua2.pyd + pjsua2.py.  Después:
#   python -c "import sys; sys.path.insert(0,'third_party/pjsua2'); import pjsua2; print(pjsua2.Endpoint().libVersion().full)"
#
# El mismo script lo ejecuta GitHub Actions (.github/workflows/build-windows.yml).

param(
    [string]$PjVersion = "2.15.1",
    [string]$Config = "Release-Dynamic",   # /MD, igual que CPython → sin conflictos de CRT
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$third = Join-Path $root "third_party"
$pjdir = Join-Path $third "pjproject"
$pydir = Join-Path $third "pjsua2"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- 1. Localizar MSBuild / entorno de Visual Studio -------------------------
Step "Buscando Visual Studio"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "No encuentro Visual Studio (vswhere.exe). Instala VS 2022 con C++." }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "Visual Studio no tiene las herramientas de C++ (VC.Tools.x86.x64)." }
$msbuild = Join-Path $vsPath "MSBuild\Current\Bin\MSBuild.exe"
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
Write-Host "VS: $vsPath"

# --- 2. Código fuente de pjproject -------------------------------------------
Step "pjproject $PjVersion"
if ($Clean -and (Test-Path $pjdir)) { Remove-Item $pjdir -Recurse -Force }
if (-not (Test-Path $pjdir)) {
    git clone --depth 1 --branch $PjVersion https://github.com/pjsip/pjproject.git $pjdir
}
$configSite = Join-Path $pjdir "pjlib\include\pj\config_site.h"
@"
/* Generado por tools/build-pjsip-windows.ps1 */
#define PJ_HAS_IPV6 1
#define PJMEDIA_HAS_SRTP 1
#define PJSUA_MAX_CALLS 4
/* Audio en escritorio: WMME (predeterminado de PJSIP en Windows). WASAPI solo existe para UWP. */
#define PJMEDIA_HAS_VIDEO 0
"@ | Set-Content -Encoding ASCII $configSite

# --- 3. Compilar las bibliotecas (libpjproject agrupa todo) --------------------
Step "msbuild libpjproject ($Config, x64) — tarda 5-10 minutos"
& $msbuild (Join-Path $pjdir "pjproject-vs14.sln") /m /nologo /v:m `
    /t:libpjproject /p:Configuration=$Config /p:Platform=x64 /p:PlatformToolset=v143 `
    /p:WindowsTargetPlatformVersion=10.0
if ($LASTEXITCODE -ne 0) { throw "msbuild falló ($LASTEXITCODE)" }
$lib = Get-ChildItem (Join-Path $pjdir "lib") -Filter "libpjproject-*-$Config.lib" | Select-Object -First 1
if (-not $lib) { throw "No se generó libpjproject-*-$Config.lib" }
Write-Host "OK: $($lib.FullName)"

# --- 4. Compilar el módulo Python con MSVC -----------------------------------
Step "Módulo Python _pjsua2.pyd"
pip install --quiet setuptools wheel
# Ejecutar dentro del entorno de VS para que setuptools encuentre cl.exe/link.exe
cmd /c "`"$vcvars`" >nul && cd /d `"$pydir`" && python setup_msvc.py --pjdir `"$pjdir`" --config $Config build_ext --inplace"
if ($LASTEXITCODE -ne 0) { throw "La compilación de _pjsua2.pyd falló" }

Step "Verificando"
$check = "import sys; sys.path.insert(0, r'$pydir'); import pjsua2; print('pjsua2', pjsua2.Endpoint().libVersion().full)"
python -c $check
if ($LASTEXITCODE -ne 0) { throw "import pjsua2 falló" }
Write-Host "`nListo: $pydir\_pjsua2*.pyd" -ForegroundColor Green
