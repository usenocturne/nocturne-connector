Unicode true
RequestExecutionLevel user
Name "Nocturne Connector"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Nocturne\Connector\App"
ShowInstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "..\assets\nocturne.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ReadEnvStr $1 "PROCESSOR_ARCHITECTURE"
  ReadEnvStr $2 "PROCESSOR_ARCHITEW6432"
  ${If} $1 == "ARM64"
    StrCpy $0 "arm64"
  ${ElseIf} $2 == "ARM64"
    StrCpy $0 "arm64"
  ${ElseIf} $1 == "AMD64"
    StrCpy $0 "x64"
  ${ElseIf} $2 == "AMD64"
    StrCpy $0 "x64"
  ${Else}
    StrCpy $0 "x86"
  ${EndIf}
  ${If} $0 == "x86"
    MessageBox MB_ICONSTOP "Nocturne Connector requires Windows x64 or ARM64."
    Abort
  ${EndIf}
FunctionEnd

Section "Nocturne Connector" SecMain
  nsExec::ExecToLog 'taskkill /F /T /IM Nocturne.Connector.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nocturne-connector-server.exe'
  SetOutPath "$INSTDIR"
  ${If} $0 == "arm64"
    File /r "${ARM64ROOT}\*"
  ${Else}
    File /r "${X64ROOT}\*"
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\Nocturne Connector"
  CreateShortCut "$SMPROGRAMS\Nocturne Connector\Nocturne Connector.lnk" "$INSTDIR\Nocturne.Connector.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector" "DisplayName" "Nocturne Connector"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector" "Publisher" "Nocturne"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Nocturne Connector" '"$INSTDIR\Nocturne.Connector.exe" --background'
  Exec '"$INSTDIR\Nocturne.Connector.exe" --background'
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /F /T /IM Nocturne.Connector.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nocturne-connector-server.exe'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Nocturne Connector"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nocturne Connector"
  Delete "$SMPROGRAMS\Nocturne Connector\Nocturne Connector.lnk"
  RMDir "$SMPROGRAMS\Nocturne Connector"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
SectionEnd
