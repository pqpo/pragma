# Run only on an elevated, isolated Windows runner. Uses the real registration helper.
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated isolated runner is required.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('pragma-editions-' + [Guid]::NewGuid())
$defaultConfig = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\.packaging\distribution.json') -Raw | ConvertFrom-Json).config
$derivedConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\..\examples\distribution.acme.json') -Raw | ConvertFrom-Json
if ($defaultConfig.id -ne 'pragma') { throw 'This acceptance requires the default release package.' }
$environmentKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
$originalPath = $environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$originalKind = $environmentKey.GetValueKind('Path')
$installations = @()
$previousOwners = @{}
function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function MachinePath { [Environment]::GetEnvironmentVariable('Path', 'Machine').Split(';') }
try {
  foreach ($config in @($defaultConfig, $derivedConfig)) {
    $directory = Join-Path $root ($config.id + ' 中文 Desktop')
    $resources = Join-Path $directory 'resources'
    $clientDirectory = Join-Path $resources 'app.asar.unpacked\out\main\desktop-cli'
    New-Item -ItemType Directory -Path $clientDirectory -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory ($config.executableName + '.exe')), '')
    [IO.File]::WriteAllText((Join-Path $clientDirectory 'pragma.js'), '')
    [IO.File]::WriteAllText((Join-Path $resources 'distribution.json'), (@{ config = $config } | ConvertTo-Json -Depth 5))
    $helper = Join-Path $resources 'terminal-integration.ps1'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\build\terminal-integration.ps1') -Destination $helper
    $ownerKey = if ($config.id -eq 'pragma') { 'HKLM:\SOFTWARE\Pragma\DesktopCLI' } else { "HKLM:\SOFTWARE\$($config.applicationId)\DesktopCLI" }
    $previousOwners[$ownerKey] = (Get-ItemProperty -LiteralPath $ownerKey -ErrorAction SilentlyContinue).CommandDirectory
    $installations += @{ directory = $directory; helper = $helper; config = $config }
    & $helper -Action repair -InstallDirectory $directory
  }
  $open = $installations[0]
  $enterprise = $installations[1]
  $openBin = Join-Path $open.directory 'bin'
  $enterpriseBin = Join-Path $enterprise.directory 'bin'
  Assert ((MachinePath) -contains $openBin) 'Default PATH entry disappeared after enterprise registration.'
  Assert ((MachinePath) -contains $enterpriseBin) 'Enterprise PATH entry is missing.'
  $enterpriseCommand = Join-Path $enterpriseBin ($derivedConfig.cliCommand + '.cmd')
  $enterpriseBytes = [IO.File]::ReadAllText($enterpriseCommand)
  Assert ($enterpriseBytes.Contains($derivedConfig.executableName + '.exe')) 'Enterprise launcher points to the wrong executable.'
  & $open.helper -Action repair -InstallDirectory $open.directory
  Assert ((MachinePath) -contains $enterpriseBin) 'Default repair changed enterprise PATH.'
  & $open.helper -Action remove -InstallDirectory $open.directory
  Assert (!(Test-Path -LiteralPath (Join-Path $openBin 'pragma.cmd'))) 'Default removal retained its launcher.'
  Assert ([IO.File]::ReadAllText($enterpriseCommand) -eq $enterpriseBytes) 'Default removal changed the enterprise launcher.'
  Assert ((MachinePath) -contains $enterpriseBin) 'Default removal changed enterprise PATH.'
  & $open.helper -Action repair -InstallDirectory $open.directory
  & $enterprise.helper -Action remove -InstallDirectory $enterprise.directory
  Assert (Test-Path -LiteralPath (Join-Path $openBin 'pragma.cmd')) 'Enterprise removal changed the default launcher.'
  Assert ((MachinePath) -contains $openBin) 'Enterprise removal changed default PATH.'
  Write-Output 'Windows distribution registration isolation passed.'
} finally {
  foreach ($installation in $installations) {
    try { & $installation.helper -Action remove -InstallDirectory $installation.directory } catch { Write-Warning 'Fixture registration cleanup failed; restoring original PATH below.' }
  }
  $environmentKey.SetValue('Path', $originalPath, $originalKind)
  $environmentKey.Close()
  foreach ($ownerKey in $previousOwners.Keys) {
    if ($previousOwners[$ownerKey]) { Set-ItemProperty -LiteralPath $ownerKey -Name CommandDirectory -Value $previousOwners[$ownerKey] }
    else { Remove-ItemProperty -LiteralPath $ownerKey -Name CommandDirectory -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
