[CmdletBinding()]
param([switch]$PlanOnly,[switch]$Diagnose,[switch]$FullValidation,[switch]$ForceDependencies,[string]$MySqlServiceName='MySQL80')
$ErrorActionPreference='Stop'
function Test-Administrator {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if((-not $PlanOnly) -and (-not $Diagnose) -and (-not (Test-Administrator))){
  Write-Host '需要 Administrator 權限；即將顯示 Windows UAC。' -ForegroundColor Yellow
  $elevated=@('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-MySqlServiceName',"`"$MySqlServiceName`"")
  if($FullValidation){$elevated+='-FullValidation'}
  if($ForceDependencies){$elevated+='-ForceDependencies'}
  try{$process=Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($elevated-join' ') -Wait -PassThru;$targetExit=$process.ExitCode}
  catch{Write-Host "無法取得 Administrator 權限：$($_.Exception.Message)" -ForegroundColor Red;$targetExit=1}
  if($targetExit-ne0){$summary=Join-Path $PSScriptRoot 'runtime\logs\LAST-ERROR.txt';if(Test-Path -LiteralPath $summary){Write-Host "`n最近失敗摘要：$summary" -ForegroundColor Yellow;Get-Content -LiteralPath $summary -Encoding UTF8}}
  exit $targetExit
}
& (Join-Path $PSScriptRoot 'install\target-environment.ps1') -PlanOnly:$PlanOnly -Diagnose:$Diagnose -FullValidation:$FullValidation -ForceDependencies:$ForceDependencies -MySqlServiceName $MySqlServiceName
$targetExit=$LASTEXITCODE
if($targetExit-ne0){
  $summary=Join-Path $PSScriptRoot 'runtime\logs\LAST-ERROR.txt'
  if(Test-Path -LiteralPath $summary){Write-Host "`n最近失敗摘要：$summary" -ForegroundColor Yellow;Get-Content -LiteralPath $summary -Encoding UTF8}
}
exit $targetExit
