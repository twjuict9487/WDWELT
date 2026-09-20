$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repository 'install\deployment.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('wdwelt-deploy-' + [guid]::NewGuid().ToString('n'))
$passed = 0
function Assert-Result($condition, $message) {if (-not $condition) {throw $message}; $script:passed++}
try {
  foreach ($failure in @('', 'fresh','broken','same','backup','migration','runtime','recovery','live','ready','firewall','availability')) {
    $caseRoot = Join-Path $testRoot $(if ($failure) {$failure} else {'success'})
    $InstallPath = Join-Path $caseRoot 'installed'
    $PackagePath = Join-Path $caseRoot 'package'
    $ConfigPath = Join-Path $InstallPath 'config\wdwelt.json'
    $NodePath = 'Invoke-TestNode'; $CanonicalHost = '192.168.0.18'; $ProductionCanonicalHost = $CanonicalHost
    $ProductionAllowedRemoteAddresses = @('192.168.0.0/22'); $AllowedRemoteAddress = @()
    $ProductionPrefixLength=22; $ProductionSubnet='192.168.0.0/22'; $ProductionGateway='192.168.1.254'
    $DeploymentEnvironmentName='fixture'; $MySqlServiceName='fixture'; $DryRun=$false; $NonInteractive=$true
    $trace = [Collections.Generic.List[string]]::new()
    foreach ($directory in @('current','tools\host','db','config','run','logs','backups')) {[IO.Directory]::CreateDirectory((Join-Path $InstallPath $directory)) | Out-Null}
    foreach ($directory in @('production','host','db','tools\database')) {[IO.Directory]::CreateDirectory((Join-Path $PackagePath $directory)) | Out-Null}
    [IO.File]::WriteAllText((Join-Path $InstallPath 'current\marker'),'old')
    [IO.File]::WriteAllText((Join-Path $InstallPath 'tools\host\server.mjs'),'old')
    [IO.File]::WriteAllText((Join-Path $InstallPath 'db\marker'),'old')
    [IO.File]::WriteAllText((Join-Path $InstallPath 'config\database.admin.json'),'admin fixture')
    [IO.File]::WriteAllText((Join-Path $InstallPath 'config\database.runtime.json'),'runtime fixture')
    [IO.File]::WriteAllText((Join-Path $InstallPath 'backups\preserve.sql'),'existing backup')
    [IO.File]::WriteAllText((Join-Path $PackagePath 'production\marker'),'new')
    [IO.File]::WriteAllText((Join-Path $PackagePath 'host\server.mjs'),'new')
    [IO.File]::WriteAllText((Join-Path $PackagePath 'db\marker'),'new')
    foreach ($name in @('wdwelt.ps1','deployment.ps1','recovery.ps1','deployment.json','database\backup.ps1','database\restore.ps1')) {[IO.File]::WriteAllText((Join-Path $PackagePath "tools\$name"),'new tool')}
    [IO.Directory]::CreateDirectory((Join-Path $InstallPath 'tools\database')) | Out-Null
    foreach ($name in @('backup.ps1','restore.ps1')) {[IO.File]::WriteAllText((Join-Path $InstallPath "tools\database\$name"),'old tool')}
    $Config = [pscustomobject]@{installPath=$InstallPath;currentPath=(Join-Path $InstallPath 'current');runPath=(Join-Path $InstallPath 'run');logPath=(Join-Path $InstallPath 'logs');backupPath=(Join-Path $InstallPath 'backups')}
    $Config | ConvertTo-Json | Set-Content -Encoding UTF8 $ConfigPath
    $initialConfig = [IO.File]::ReadAllText($ConfigPath)
    function Validate-Package($path) {$trace.Add('validate'); [pscustomobject]@{Root=$PackagePath;Release=[pscustomobject]@{version='0.3.0';build='new'}}}
    function Resolve-InputPath($path) {return $path}
    function Assert-AllowedRemoteAddresses($addresses) {return $addresses}
    function Read-Release($path) {return [pscustomobject]@{build='old'}}
    function Test-Administrator {return $true}
    function Assert-ProductionNetwork {}
    function Get-Service {return [pscustomobject]@{Status='Running'}}
    function Invoke-TestNode {
      $global:LASTEXITCODE=0
      if ($args[0] -like '*preflight.mjs') {return '{"database":[{"value":"g2"}],"bindAddress":[{"Value":"127.0.0.1"}],"mysqlxBindAddress":[{"Value":"127.0.0.1"}]}'}
      if ($args[0] -like '*backup.mjs') {
        $trace.Add('backup')
        if ($failure -eq 'backup') {$global:LASTEXITCODE=1; return}
        return (@{path=(Join-Path $InstallPath 'backups\pre-reinstall-fixture.sql')} | ConvertTo-Json -Compress)
      }
      if ($args[0] -like '*migrate.mjs') {$trace.Add('migrate'); if ($failure -eq 'migration') {$global:LASTEXITCODE=1}}
      if ($args[0] -like '*repair-runtime.mjs') {$trace.Add('runtime'); if ($failure -eq 'runtime') {$global:LASTEXITCODE=1}}
    }
    function Ensure-Directories {}
    function Acquire-MaintenanceLock {$trace.Add('lock')}
    function Release-MaintenanceLock {$trace.Add('unlock')}
    function Stop-Wdwelt {$trace.Add('stop')}
    function Test-PathWithin($path,$root) {return [IO.Path]::GetFullPath($path).StartsWith([IO.Path]::GetFullPath($root)+'\')}
    function powershell.exe {$trace.Add('recovery'); $global:LASTEXITCODE=if ($failure -eq 'recovery') {1} else {0}}
    function Read-WdweltConfig {return (Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json)}
    function Copy-FileAtomically($source,$target) {[IO.Directory]::CreateDirectory((Split-Path -Parent $target))|Out-Null; Copy-Item -LiteralPath $source -Destination $target -Force}
    function Install-Tasks {$trace.Add('tasks')}
    function Install-Firewall {$trace.Add('firewall'); if ($failure -eq 'firewall') {throw 'injected firewall failure'}}
    function Start-Wdwelt {$trace.Add('start')}
    function Invoke-LiveHealth {if ($failure -eq 'live' -and [IO.File]::ReadAllText((Join-Path $InstallPath 'current\marker')) -eq 'new') {return $null}; return @{build='new'}}
    function Invoke-ReadyHealth {if ($failure -eq 'ready' -and [IO.File]::ReadAllText((Join-Path $InstallPath 'current\marker')) -eq 'new') {return $null}; return @{build='new'}}
    function Invoke-RestMethod {return @{available=($failure -ne 'availability')}}
    function Test-Network {$trace.Add('network')}
    function Get-VerifiedHost {return $true}
    if ($failure -eq 'fresh') {
      Remove-Item -LiteralPath $ConfigPath
      Remove-Item -LiteralPath (Join-Path $InstallPath 'current'),(Join-Path $InstallPath 'tools\host'),(Join-Path $InstallPath 'db') -Recurse -Force
    }
    if ($failure -eq 'broken') {Remove-Item -LiteralPath (Join-Path $InstallPath 'tools\host\server.mjs')}
    if ($failure -eq 'same') {function Read-Release {return [pscustomobject]@{build='new'}}}
    $expectedFailure = $failure -in @('backup','migration','runtime','recovery','live','ready','firewall','availability')
    $failed = $false
    try {Invoke-Install} catch {$failed=$true}
    Assert-Result ($failed -eq $expectedFailure) "Unexpected result for $failure"
    Assert-Result ([IO.File]::ReadAllText((Join-Path $InstallPath 'current\marker')) -eq $(if ($expectedFailure) {'old'} else {'new'})) "Release preservation failed for $failure"
    Assert-Result ([IO.File]::ReadAllText((Join-Path $InstallPath 'config\database.runtime.json')) -eq 'runtime fixture') 'Runtime config overwritten'
    Assert-Result (Test-Path -LiteralPath (Join-Path $InstallPath 'backups\preserve.sql')) 'Existing backup removed'
    if ($failure -eq 'backup') {Assert-Result (-not $trace.Contains('stop')) 'Backup failure stopped existing service'}
    else {Assert-Result ($trace.IndexOf('backup') -lt $trace.IndexOf('stop')) 'Service stopped before backup'}
    if ($expectedFailure) {Assert-Result ([IO.File]::ReadAllText($ConfigPath) -eq $initialConfig) 'Rollback did not restore configuration'}
    foreach ($name in @('backup.ps1','restore.ps1')) {
      Assert-Result ([IO.File]::ReadAllText((Join-Path $InstallPath "tools\database\$name")) -eq $(if ($expectedFailure) {'old tool'} else {'new tool'})) "Management tool preservation failed: $name"
    }
  }
  Write-Host "Deployment repair fault injection passed: $passed checks"
} finally {
  $resolved=[IO.Path]::GetFullPath($testRoot)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -or [IO.Path]::GetFileName($resolved) -notlike 'wdwelt-deploy-*') {throw 'Unsafe fixture cleanup'}
  if (Test-Path -LiteralPath $resolved) {Remove-Item -LiteralPath $resolved -Recurse -Force}
}
