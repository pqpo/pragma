; electron-builder uninstalls both SHELL_CONTEXT and HKCU prior installations.
; Its --updated path preserves per-user application data during scope migration.
!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\terminal-integration.ps1" -Action repair -InstallDirectory "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Pragma CLI registration failed. Re-run the installer as administrator to repair terminal integration."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\resources\terminal-integration.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\terminal-integration.ps1" -Action remove -InstallDirectory "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Pragma CLI removal failed. Retry uninstalling as administrator."
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend
