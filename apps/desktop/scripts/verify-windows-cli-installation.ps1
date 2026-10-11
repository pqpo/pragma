# Native release acceptance on an isolated, elevated Windows runner.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run installer acceptance on an elevated, isolated Windows runner.'
}
$installer = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\dist') -Filter '*-win-x64.exe' | Select-Object -First 1
if (!$installer) { throw 'Windows installer is missing.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('pragma-cli-install-' + [Guid]::NewGuid().ToString())
$installation = Join-Path $root 'Pragma 中文 Desktop'
$other = Join-Path $root 'other-cli'
$state = Join-Path $root 'state'
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
$originalPath = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$originalKind = $key.GetValueKind('Path')
$originalProcessPath = $env:Path
$originalPragmaHome = $env:PRAGMA_HOME
$uninstaller = Join-Path $installation 'Uninstall Pragma.exe'
function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function InstallDesktop {
  # NSIS /D is deliberately last and unquoted; it consumes the rest of the command line.
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installation" -Wait -PassThru
  Assert ($process.ExitCode -eq 0) "Installer exited $($process.ExitCode)."
}
function RefreshMachinePath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') }
function VerifyInstalledCli {
  RefreshMachinePath
  $bin = Join-Path $installation 'bin'
  Assert ($env:Path.Split(';')[0] -ieq $bin) 'Desktop must be first in Machine PATH.'
  Assert ((Get-Command pragma).Source -ieq (Join-Path $bin 'pragma.cmd')) 'Default pragma must resolve to Desktop.'
  # Remove all other tools from the CLI's environment: Node/npm must not be required.
  $env:Path = $bin
  try {
    $raw = & (Join-Path $bin 'pragma.cmd') version --format json
    Assert ($LASTEXITCODE -eq 0) 'Bundled pragma failed without Node on PATH.'
    $version = ($raw -join "`n") | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath (Join-Path $installation 'resources\app.asar.unpacked\out\main\desktop-cli\distribution.json') -Raw | ConvertFrom-Json
    Assert ($version.result.cliVersion -eq $metadata.cliVersion) 'Installed CLI version differs from its bundle.'
    Assert ($version.result.desktopBundleVersion -eq $metadata.desktopVersion) 'Installed CLI reports a different Desktop.'
    & (Join-Path $bin 'pragma-desktop.cmd') --help | Out-Null
    Assert ($LASTEXITCODE -eq 0) 'Explicit Desktop command failed.'
  } finally { RefreshMachinePath }
}
try {
  New-Item -ItemType Directory -Path $other,$state -Force | Out-Null
  $otherCli = Join-Path $other 'pragma.cmd'
  [IO.File]::WriteAllText($otherCli, "@echo off`r`necho independent-version`r`n", [Text.Encoding]::ASCII)
  $key.SetValue('Path', "$other;$originalPath", $originalKind)
  $env:PRAGMA_HOME = $state
  InstallDesktop
  VerifyInstalledCli
  Assert ((& $otherCli) -eq 'independent-version') 'Other CLI was changed.'
  $sentinel = Join-Path $state 'user-data-sentinel'
  [IO.File]::WriteAllText($sentinel, 'preserved')
  InstallDesktop
  VerifyInstalledCli
  Assert ([IO.File]::ReadAllText($sentinel) -eq 'preserved') 'Upgrade changed user data.'
  $helper = Join-Path $installation 'resources\terminal-integration.ps1'
  & $helper -Action remove -InstallDirectory $installation
  RefreshMachinePath
  Assert (!(Test-Path -LiteralPath (Join-Path $installation 'bin\pragma.cmd'))) 'Removal left the owned CLI.'
  Assert ((Get-Command pragma).Source -ieq $otherCli) 'Removal must restore the other CLI.'
  & $helper -Action repair -InstallDirectory $installation
  VerifyInstalledCli
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S /allusers' -Wait -PassThru
  Assert ($process.ExitCode -eq 0) "Uninstaller exited $($process.ExitCode)."
  RefreshMachinePath
  Assert ((Get-Command pragma).Source -ieq $otherCli) 'Uninstall changed another CLI or retained Desktop PATH.'
  Assert ([IO.File]::ReadAllText($sentinel) -eq 'preserved') 'Uninstall changed Pragma data.'
  Write-Output 'Windows installer CLI acceptance passed: first install, upgrade, removal, repair, uninstall and coexistence.'
} finally {
  if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S /allusers' -Wait | Out-Null }
  $key.SetValue('Path', $originalPath, $originalKind)
  $key.Close()
  $env:Path = $originalProcessPath
  $env:PRAGMA_HOME = $originalPragmaHome
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
