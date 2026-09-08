[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupFile,
  [string]$ConfigPath,
  [string]$AdminConfigPath
)

$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Resolve-LocalPath([string]$Value,[string]$Base){if([IO.Path]::IsPathRooted($Value)){return [IO.Path]::GetFullPath($Value)};return [IO.Path]::GetFullPath((Join-Path $Base $Value))}
$ConfigPath=if($ConfigPath){Resolve-LocalPath $ConfigPath $PSScriptRoot}else{Join-Path $ProjectRoot 'config\development.json'}
$config=Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath|ConvertFrom-Json
$configDirectory=Split-Path -Parent $ConfigPath
$AdminConfigPath=if($AdminConfigPath){Resolve-LocalPath $AdminConfigPath $PSScriptRoot}elseif($config.adminDatabaseConfigPath){Resolve-LocalPath ([string]$config.adminDatabaseConfigPath) $configDirectory}else{throw '設定缺少 adminDatabaseConfigPath。'}
$BackupFile=Resolve-LocalPath $BackupFile $PSScriptRoot
$runPath=Resolve-LocalPath ([string]$config.runPath) $configDirectory
$logPath=Resolve-LocalPath ([string]$config.logPath) $configDirectory
$node=if($config.nodePath){Resolve-LocalPath ([string]$config.nodePath) $configDirectory}else{(Get-Command node -ErrorAction Stop).Source}
$tool=if(Test-Path -LiteralPath (Join-Path $ProjectRoot 'install\wdwelt.ps1')){Join-Path $ProjectRoot 'install\wdwelt.ps1'}else{Join-Path $ProjectRoot 'tools\wdwelt.ps1'};$restoreScript=Join-Path $ProjectRoot 'db\operations\restore.mjs';$migrations=Join-Path $ProjectRoot 'db\migrations';$lock=Join-Path $runPath 'maintenance-lock.json'
function Write-RestoreLog([string]$Level,[string]$Event,[string]$Message){[IO.Directory]::CreateDirectory($logPath)|Out-Null;$record=[ordered]@{timestamp=[DateTimeOffset]::UtcNow.ToString('o');level=$Level;event=$Event;version='0.3.0';build='database';message=$Message};Add-Content -Encoding UTF8 -LiteralPath (Join-Path $logPath 'operations.jsonl') -Value ($record|ConvertTo-Json -Compress)}
$lockAcquired=$false
try{
  Write-RestoreLog info restore_start 'Database restore started.'
  & (Join-Path $PSScriptRoot 'backup.ps1') -ConfigPath $ConfigPath -DatabaseConfigPath $AdminConfigPath -Label 'pre-restore'
  if($LASTEXITCODE-ne0){throw 'Pre-restore backup failed; restore was not started.'}
  [IO.Directory]::CreateDirectory($runPath)|Out-Null
  if(Test-Path -LiteralPath $lock){throw 'Maintenance lock already exists; restore was not started.'}
  @{owner='restore';expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(30).ToString('o');timestamp=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $lock
  $lockAcquired=$true
  & $tool stop -ConfigPath $ConfigPath
  if($LASTEXITCODE-ne0){throw 'WDWELT could not enter restore maintenance state.'}
  & $node $restoreScript --config $AdminConfigPath --backup $BackupFile --migrations $migrations
  if($LASTEXITCODE-ne0){throw 'Database restore or migration verification failed; WDWELT remains manually stopped.'}
  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue;$lockAcquired=$false
  & $tool start -ConfigPath $ConfigPath
  if($LASTEXITCODE-ne0){throw 'Restore completed but WDWELT readiness failed.'}
  $ready=Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health/ready' -TimeoutSec 5
  if($ready.status-ne'ok'){throw 'Restore completed but /health/ready is not healthy.'}
  Write-RestoreLog info restore_success 'Database restore completed; sessions were cleared.'
  Write-Host 'Restore completed; all sessions were cleared and users must log in again.'
  exit 0
}catch{Write-RestoreLog error restore_failure 'Database restore failed; inspect the local operations log.';Write-Error $_.Exception.Message;exit 1}finally{if($lockAcquired){Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue}}
