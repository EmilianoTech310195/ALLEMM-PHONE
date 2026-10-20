# Compila AllemmSIP.exe y el instalador en Windows con un solo comando.
#
#   1. Instala Visual Studio 2022 (con C++), Python 3.11+ (64 bits, en PATH) y Git.
#   2. Abre PowerShell en esta carpeta y ejecuta:   .\build-windows.ps1
#      (si PowerShell bloquea scripts:  Set-ExecutionPolicy -Scope Process Bypass)
#
# Resultado:  dist\AllemmSIP\AllemmSIP.exe       (versión portable)
#             installer-out\AllemmSIP-Setup.exe  (instalador, si Inno Setup está instalado)

param([switch]$SkipPjsip)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Step "Entorno virtual de Python"
if (-not (Test-Path ".venv")) { python -m venv .venv }
& .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip --quiet
pip install -e ".[desktop,dev]" --quiet

if (-not $SkipPjsip -and -not (Get-ChildItem third_party\pjsua2 -Filter "_pjsua2*.pyd" -ErrorAction SilentlyContinue)) {
    Step "Compilando PJSIP + pjsua2 (solo la primera vez, 5-10 min)"
    & .\tools\build-pjsip-windows.ps1
}

Step "Pruebas"
python -m pytest -q
if ($LASTEXITCODE -ne 0) { throw "Las pruebas fallaron" }

Step "Compilando con PyInstaller (1-2 minutos)"
pyinstaller allemmsip.spec --noconfirm --log-level WARN
Copy-Item README.md dist\AllemmSIP\LEEME.md -Force
Write-Host "Listo: dist\AllemmSIP\AllemmSIP.exe" -ForegroundColor Green

Step "Instalador (Inno Setup)"
$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (Test-Path $iscc) {
    if (-not (Test-Path "MicrosoftEdgeWebView2Setup.exe")) {
        Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile MicrosoftEdgeWebView2Setup.exe
    }
    & $iscc installer\AllemmSIP.iss | Select-String -Pattern "Successful|error" -CaseSensitive:$false
    Write-Host "Listo: installer-out\AllemmSIP-Setup.exe" -ForegroundColor Green
} else {
    Write-Host "Inno Setup no está instalado; se omite el instalador. Instálalo desde https://jrsoftware.org/isdl.php y vuelve a ejecutar." -ForegroundColor Yellow
    Write-Host "Mientras tanto puedes usar la versión portable: dist\AllemmSIP\AllemmSIP.exe"
}
