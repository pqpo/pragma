param(
  [Parameter(Mandatory=$true)][ValidateSet('repair','remove')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Global\PragmaDesktopTerminalIntegration')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'CLI_REGISTRATION_BUSY: Retry terminal integration.' }
  $directory = Join-Path $InstallDirectory 'bin'
  $executable = Join-Path $InstallDirectory 'Pragma.exe'
  $client = Join-Path $InstallDirectory 'resources\app.asar.unpacked\out\main\desktop-cli\pragma.js'
  $environmentKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
  if (!$environmentKey) { throw 'CLI_PERMISSION_DENIED: Run the installer as administrator.' }
  $oldPath = $environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $pathKind = $environmentKey.GetValueKind('Path')
  $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $ownerKey = $machine.CreateSubKey('SOFTWARE\Pragma\DesktopCLI')
  $previous = $ownerKey.GetValue('CommandDirectory', '')
  if ($Action -eq 'repair') {
    if (!(Test-Path -LiteralPath $executable) -or !(Test-Path -LiteralPath $client)) { throw 'CLI_BUNDLE_MISSING: Reinstall Desktop.' }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    # ASCII relative paths preserve Unicode installation paths without changing console encoding.
    $content = '@echo off' + "`r`n" + 'rem Pragma Desktop CLI launcher' + "`r`n" + 'setlocal' + "`r`n" + 'if not exist "%~dp0..\Pragma.exe" (echo Pragma Desktop has been removed. Reinstall Desktop. 1>&2 & exit /b 127)' + "`r`n" + 'set ELECTRON_RUN_AS_NODE=1' + "`r`n" + '"%~dp0..\Pragma.exe" "%~dp0..\resources\app.asar.unpacked\out\main\desktop-cli\pragma.js" %*' + "`r`n" + 'exit /b %errorlevel%' + "`r`n"
    foreach ($name in @('pragma.cmd','pragma-desktop.cmd')) {
      $target = Join-Path $directory $name
      if ((Test-Path -LiteralPath $target) -and !([IO.File]::ReadAllText($target).Contains('rem Pragma Desktop CLI launcher'))) { throw "CLI_ENTRY_CONFLICT: $target belongs to another installation." }
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
    foreach ($name in @('pragma.cmd','pragma-desktop.cmd')) {
      $target = Join-Path $cleanupDirectory $name
      if ((Test-Path -LiteralPath $target) -and ([IO.File]::ReadAllText($target).Contains('rem Pragma Desktop CLI launcher'))) { Remove-Item -LiteralPath $target }
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
}
