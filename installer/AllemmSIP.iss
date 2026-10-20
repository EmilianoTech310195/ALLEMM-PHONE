; Inno Setup 6 - instalador de ALLEMM SIP para Windows.
; Se compila con: ISCC.exe installer\AllemmSIP.iss
; Espera dist\AllemmSIP\ (salida de PyInstaller) y MicrosoftEdgeWebView2Setup.exe en la raíz.

#define AppName "ALLEMM SIP"
#define AppVersion GetEnv("APP_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif
#define AppExe "AllemmSIP.exe"

[Setup]
AppId={{B4A7C2E1-5D3F-4F8A-9C0B-7E2D1A6F3C55}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=EmilianoTech
AppPublisherURL=https://github.com/EmilianoTech310195/ALLEMM-PHONE
DefaultDirName={autopf}\AllemmSIP
DefaultGroupName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\installer-out
OutputBaseFilename=AllemmSIP-Setup
SetupIconFile=..\allemmsip\static\img\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
ChangesAssociations=yes

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Iniciar {#AppName} al encender Windows"; GroupDescription: "Inicio:"; Flags: unchecked
Name: "telproto"; Description: "Abrir enlaces tel: y callto: (click-to-call desde CRM / navegador)"; GroupDescription: "Integración:"

[Files]
Source: "..\dist\AllemmSIP\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\MicrosoftEdgeWebView2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not WebView2Installed

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Registry]
; Protocolos tel: / callto: / sip:  →  AllemmSIP.exe "tel:+52..."
Root: HKCU; Subkey: "Software\Classes\tel"; ValueType: string; ValueName: ""; ValueData: "URL:Tel Protocol"; Flags: uninsdeletekey; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\tel"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\tel\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\tel\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\callto"; ValueType: string; ValueName: ""; ValueData: "URL:CallTo Protocol"; Flags: uninsdeletekey; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\callto"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\callto\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\callto\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\sip"; ValueType: string; ValueName: ""; ValueData: "URL:SIP Protocol"; Flags: uninsdeletekey; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\sip"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: telproto
Root: HKCU; Subkey: "Software\Classes\sip\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: telproto

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Instalando Microsoft Edge WebView2..."; Check: not WebView2Installed; Flags: waituntilterminated
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Result then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;
