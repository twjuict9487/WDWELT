param([string]$Repository,[string]$FixtureRoot,[string]$AdminConfig,[string]$RuntimeConfig)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Repository 'install\wdwelt.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Manager parse failed'}
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {Invoke-Expression $definition.Extent.Text}
. (Join-Path $Repository 'install\deployment.ps1')
$SourceRoot=$Repository; $ScriptRoot=Join-Path $Repository 'install'
$InstallPath=Join-Path $FixtureRoot 'installer integration'
$ConfigPath=Join-Path $InstallPath 'config\wdwelt.json'
$PackagePath=Join-Path $Repository 'artifacts\wdwelt-package'
$AdminDatabaseConfigPath=$AdminConfig; $DatabaseConfigPath=$RuntimeConfig
$NodePath=(Get-Command node).Source
$Command='install'; $DryRun=$false; $NonInteractive=$true
$CanonicalHost='127.0.0.1'; $ProductionCanonicalHost=$CanonicalHost
$AllowedRemoteAddress=@('127.0.0.1'); $ProductionAllowedRemoteAddresses=$AllowedRemoteAddress
$ProductionSubnet='127.0.0.0/8'; $ProductionPrefixLength=8; $ProductionGateway='127.0.0.1'
$DeploymentEnvironmentName='isolated-test'; $MySqlServiceName='isolated-test'
$Config=[pscustomobject]@{installPath=$InstallPath; currentPath=(Join-Path $InstallPath 'current'); logPath=(Join-Path $InstallPath 'logs'); runPath=(Join-Path $InstallPath 'run'); backupPath=(Join-Path $InstallPath 'backups'); maintenanceLockMinutes=15}
$PidFile=Join-Path $Config.runPath 'host.pid.json'
$ManualStopFile=Join-Path $Config.runPath 'manual-stop.json'
$LockFile=Join-Path $Config.runPath 'maintenance-lock.json'
$FailureFile=Join-Path $Config.runPath 'health-failures.json'
$DesiredFile=Join-Path $Config.runPath 'desired-state.json'
# Only operating-system provisioning is substituted. DB tools, package validation,
# file replacement, credential ACLs, host lifecycle and HTTP checks are real.
function Test-Administrator {return $true}
function Assert-ProductionNetwork {}
function Assert-AllowedRemoteAddresses($addresses) {return $addresses}
function Get-Service {return [pscustomobject]@{Status='Running'}}
function Install-Tasks {}
function Install-Firewall {}
function Test-Network {}
try {
  Invoke-Install
  $installedRuntime=Join-Path $InstallPath 'config\database.runtime.json'
  $runtimeBefore=[IO.File]::ReadAllText($installedRuntime)
  Invoke-Install
  if ([IO.File]::ReadAllText($installedRuntime) -ne $runtimeBefore) {throw 'Reinstall replaced valid runtime credential'}
  $marker=Join-Path $InstallPath 'current\rollback-marker'
  [IO.File]::WriteAllText($marker,'previous release')
  $script:readyCalls=0
  function Invoke-ReadyHealth([int]$TimeoutSeconds=5) {
    $script:readyCalls++
    if ($script:readyCalls -eq 2) {return $null}
    Invoke-HealthEndpoint '/health/ready' $TimeoutSeconds
  }
  $failed=$false
  try {Invoke-Install} catch {$failed=$true}
  if (-not $failed) {throw 'Injected readiness failure did not abort deployment'}
  if (-not (Test-Path -LiteralPath $marker)) {throw 'Previous release not restored'}
  if (-not (Invoke-LiveHealth) -or -not (Invoke-ReadyHealth)) {throw 'Restored real host not healthy'}
  if (@(Get-ChildItem -LiteralPath $Config.backupPath -Filter 'pre-reinstall-*.sql').Count -ne 3) {throw 'Expected a backup before each deployment'}
  Write-Host 'REAL DEPLOYMENT DATABASE INTEGRATION PASSED'
} finally {
  if (Get-VerifiedHost) {Stop-Wdwelt -Maintenance}
}
