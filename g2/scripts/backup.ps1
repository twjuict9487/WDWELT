[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$DatabaseConfigPath,
  [ValidatePattern('^[a-zA-Z0-9-]+$')][string]$Label = 'manual'
)

$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Resolve-LocalPath([string]$Value,[string]$Base){if([IO.Path]::IsPathRooted($Value)){return [IO.Path]::GetFullPath($Value)};return [IO.Path]::GetFullPath((Join-Path $Base $Value))}
$ConfigPath=if($ConfigPath){Resolve-LocalPath $ConfigPath $PSScriptRoot}else{Join-Path $ProjectRoot 'g2\config.development.json'}
$config=Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath|ConvertFrom-Json
$configDirectory=Split-Path -Parent $ConfigPath
$databaseConfig=if($DatabaseConfigPath){Resolve-LocalPath $DatabaseConfigPath $PSScriptRoot}elseif($config.adminDatabaseConfigPath){Resolve-LocalPath ([string]$config.adminDatabaseConfigPath) $configDirectory}else{throw '設定缺少 adminDatabaseConfigPath。'}
$backupPath=Resolve-LocalPath ([string]$config.backupPath) $configDirectory
$logPath=Resolve-LocalPath ([string]$config.logPath) $configDirectory
$node=if($config.nodePath){Resolve-LocalPath ([string]$config.nodePath) $configDirectory}else{(Get-Command node -ErrorAction Stop).Source}
$script=Join-Path $ProjectRoot 'db\backup.mjs'
function Write-BackupLog([string]$Level,[string]$Event,[string]$Message){[IO.Directory]::CreateDirectory($logPath)|Out-Null;$record=[ordered]@{timestamp=[DateTimeOffset]::UtcNow.ToString('o');level=$Level;event=$Event;version='0.3.0';build='database';message=$Message};Add-Content -Encoding UTF8 -LiteralPath (Join-Path $logPath 'operations.jsonl') -Value ($record|ConvertTo-Json -Compress)}
try{
  Write-BackupLog info backup_start "Backup label $Label started."
  & $node $script --config $databaseConfig --output $backupPath --label $Label
  if($LASTEXITCODE-ne0){throw 'Database backup failed.'}
  Write-BackupLog info backup_success "Backup label $Label completed."
  exit 0
}catch{Write-BackupLog error backup_failure $_.Exception.Message;Write-Error $_.Exception.Message;exit 1}
