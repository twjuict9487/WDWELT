[CmdletBinding()]
param([switch]$PlanOnly,[string]$MySqlServiceName='MySQL80')
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repository
if($PlanOnly){
  $deployment=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repository 'config\deployment.json')|ConvertFrom-Json
  Write-Host "Target setup: http://$($deployment.hostAddress):8080/; MySQL service: $MySqlServiceName"
  Write-Host 'Actions: npm ci, create/verify g2, set root/wdwelt_app local credentials, build/package, backup/migrate, install tasks/firewall, verify host, initialize master recovery password if missing.'
  Write-Host 'PlanOnly: no files, database, services, tasks or firewall were changed.'
  exit 0
}
try {
  $npm=(Get-Command npm.cmd -ErrorAction Stop).Source
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  & $npm ci --include=dev --no-audit --fund=false
  if($LASTEXITCODE-ne0){throw 'npm dependency installation failed.'}
  & $node (Join-Path $repository 'db\operations\target-environment.mjs')
  if($LASTEXITCODE-ne0){throw 'Fixed MySQL configuration failed.'}
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bootstrap.ps1') -ExistingAccounts -NonInteractive -MySqlServiceName $MySqlServiceName
  if($LASTEXITCODE-ne0){throw 'Application installation failed.'}
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'target-recovery.ps1')
  if($LASTEXITCODE-ne0){throw 'Master recovery password initialization failed.'}
  Write-Host 'TARGET ENVIRONMENT READY: http://192.168.0.18:8080/'
} catch {
  Write-Host "Target environment setup failed: $($_.Exception.Message)"
  exit 1
}
