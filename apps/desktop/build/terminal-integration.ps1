param(
  [Parameter(Mandatory=$true)][ValidateSet('repair','remove')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$distributionProfile = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'distribution.json') -Raw | ConvertFrom-Json
$identity = $distributionProfile.config
$marker = if ($identity.id -eq 'pragma') { 'rem Pragma Desktop CLI launcher' } else { "rem $($identity.id) Desktop CLI launcher" }
$commands = @("$($identity.cliCommand).cmd", "$($identity.desktopCliCommand).cmd")
$mutexName = if ($identity.id -eq 'pragma') { 'Global\PragmaDesktopTerminalIntegration' } else { "Global\$($identity.id)DesktopTerminalIntegration" }
$registryPath = if ($identity.id -eq 'pragma') { 'SOFTWARE\Pragma\DesktopCLI' } else { "SOFTWARE\$($identity.applicationId)\DesktopCLI" }
# All editions mutate the same Machine PATH; retain the legacy shared lock too.
$pathMutex = [Threading.Mutex]::new($false, 'Global\PragmaDesktopTerminalIntegration')
$pathLocked = $false
$mutex = [Threading.Mutex]::new($false, $mutexName)
$locked = $false
try {
  try { $pathLocked = $pathMutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $pathLocked = $true }
  if (!$pathLocked) { throw 'CLI_REGISTRATION_BUSY: Retry terminal integration.' }
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'CLI_REGISTRATION_BUSY: Retry terminal integration.' }
  $directory = Join-Path $InstallDirectory 'bin'
  $executable = Join-Path $InstallDirectory "$($identity.executableName).exe"
  $client = Join-Path $InstallDirectory 'resources\app.asar.unpacked\out\main\desktop-cli\pragma.js'
  $environmentKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
  if (!$environmentKey) { throw 'CLI_PERMISSION_DENIED: Run the installer as administrator.' }
  $oldPath = $environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $pathKind = $environmentKey.GetValueKind('Path')
  $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $ownerKey = $machine.CreateSubKey($registryPath)
  $previous = $ownerKey.GetValue('CommandDirectory', '')
  if ($Action -eq 'repair') {
    if (!(Test-Path -LiteralPath $executable) -or !(Test-Path -LiteralPath $client)) { throw 'CLI_BUNDLE_MISSING: Reinstall Desktop.' }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    # ASCII relative paths preserve Unicode installation paths without changing console encoding.
    $relativeExecutable = '%~dp0..\' + $identity.executableName + '.exe'
    $content = '@echo off' + "`r`n" + $marker + "`r`n" + 'setlocal' + "`r`n" + ('if not exist "' + $relativeExecutable + '" (echo Desktop has been removed. Reinstall Desktop. 1>&2 & exit /b 127)') + "`r`n" + 'set ELECTRON_RUN_AS_NODE=1' + "`r`n" + ('"' + $relativeExecutable + '" "%~dp0..\resources\app.asar.unpacked\out\main\desktop-cli\pragma.js" %*') + "`r`n" + 'exit /b %errorlevel%' + "`r`n"
    foreach ($name in $commands) {
      $target = Join-Path $directory $name
      if ((Test-Path -LiteralPath $target) -and !([IO.File]::ReadAllText($target).Contains($marker))) { throw "CLI_ENTRY_CONFLICT: $target belongs to another installation." }
      $temporary = "$target.$([Guid]::NewGuid()).tmp"
      try {
        [IO.File]::WriteAllText($temporary, $content, [Text.Encoding]::ASCII)
        Move-Item -LiteralPath $temporary -Destination $target -Force
      } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    }
  }
  $parts = @($oldPath.Split(';') | Where-Object {
    $_.Trim().Trim('"').TrimEnd('\') -ine $directory.TrimEnd('\') -and
    ($Action -eq 'remove' -or !$previous -or $_.Trim().Trim('"').TrimEnd('\') -ine $previous.TrimEnd('\'))
  })
  if ($Action -eq 'repair') { $parts = @($directory) + $parts }
  $environmentKey.SetValue('Path', ($parts -join ';'), $pathKind)
  if ($Action -eq 'repair') { $ownerKey.SetValue('CommandDirectory', $directory) }
  elseif ($previous -ieq $directory) { $ownerKey.DeleteValue('CommandDirectory', $false) }
  $ownerKey.Close()
  $machine.Close()
  $environmentKey.Close()
  if ($Action -eq 'remove' -or ($previous -and $previous -ine $directory)) {
    $cleanupDirectory = if ($Action -eq 'remove') { $directory } else { $previous }
    foreach ($name in $commands) {
      $target = Join-Path $cleanupDirectory $name
      if ((Test-Path -LiteralPath $target) -and ([IO.File]::ReadAllText($target).Contains($marker))) { Remove-Item -LiteralPath $target }
    }
  }
  if (!('PragmaEnvironment' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PragmaEnvironment {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
  }
  $result = [UIntPtr]::Zero
  [PragmaEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if ($pathLocked) { $pathMutex.ReleaseMutex() }
  $pathMutex.Dispose()
}
