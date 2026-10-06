[CmdletBinding()]
param([switch]$PlanOnly,[switch]$StartOnly,[string]$MySqlServiceName='MySQL80')

$ErrorActionPreference='Stop'
$kitRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$archive=Join-Path $kitRoot 'payload.zip'
$hashFile=Join-Path $kitRoot 'payload.sha256'
$runtime=Join-Path $kitRoot 'runtime'
$payload=Join-Path $runtime 'payload'
$logRoot=Join-Path $runtime 'logs'
$logPath=$null
$stage='啟動精簡目標安裝器'
$installRoot=Join-Path $env:ProgramData 'WDWELT'
$installedTool=Join-Path $installRoot 'tools\wdwelt.ps1'
$installedConfig=Join-Path $installRoot 'config\wdwelt.json'

function Test-Administrator {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-SetupLine([string]$Message,[ConsoleColor]$Color=[ConsoleColor]::Gray){
  Write-Host $Message -ForegroundColor $Color
  if($script:logPath){Add-Content -LiteralPath $script:logPath -Encoding UTF8 -Value $Message}
}

function Invoke-SetupProcess([string]$Stage,[string]$FilePath,[string[]]$Arguments){
  $script:stage=$Stage
  Write-SetupLine "`n[$Stage]" Cyan
  $previous=$ErrorActionPreference
  try{$ErrorActionPreference='Continue';$output=@(& $FilePath @Arguments 2>&1);$exitCode=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
  foreach($line in $output){$text=[string]$line;Write-Host $text;Add-Content -LiteralPath $script:logPath -Encoding UTF8 -Value $text}
  if($exitCode-ne0){throw "$Stage failed with exit code $exitCode.$([Environment]::NewLine)$(($output|Select-Object -Last 12|ForEach-Object{[string]$_})-join[Environment]::NewLine)"}
}

function Restart-ElevatedIfNeeded {
  if(Test-Administrator){return $false}
  Write-Host '需要 Administrator 權限；即將顯示 Windows UAC。' -ForegroundColor Yellow
  $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-MySqlServiceName',('"'+$MySqlServiceName+'"'))
  if($StartOnly){$arguments+='-StartOnly'}
  $process=Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($arguments-join' ') -Wait -PassThru
  exit $process.ExitCode
}

function Assert-Payload {
  if(-not(Test-Path -LiteralPath $archive -PathType Leaf)-or-not(Test-Path -LiteralPath $hashFile -PathType Leaf)){throw 'Target kit 缺少 payload.zip 或 payload.sha256。'}
  $expected=(Get-Content -Raw -LiteralPath $hashFile).Trim().ToLowerInvariant()
  if($expected-notmatch'^[0-9a-f]{64}$'){throw 'payload.sha256 格式不合法。'}
  $actual=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual-ne$expected){throw 'payload.zip SHA-256 驗證失敗；請重新下載並解壓 target kit。'}
  return $actual
}

function Expand-VerifiedPayload([string]$Hash){
  $marker=Join-Path $payload '.payload.sha256'
  if((Test-Path -LiteralPath (Join-Path $payload 'manifest.json') -PathType Leaf)-and(Test-Path -LiteralPath $marker -PathType Leaf)-and((Get-Content -Raw -LiteralPath $marker).Trim()-eq$Hash)){return}
  [IO.Directory]::CreateDirectory($runtime)|Out-Null
  $stagePath=Join-Path $runtime "payload-stage-$PID"
  if(Test-Path -LiteralPath $stagePath){Remove-Item -LiteralPath $stagePath -Recurse -Force}
  try{
    Expand-Archive -LiteralPath $archive -DestinationPath $stagePath -Force
    if(-not(Test-Path -LiteralPath (Join-Path $stagePath 'manifest.json') -PathType Leaf)){throw 'payload.zip 缺少 manifest.json。'}
    $Hash|Set-Content -LiteralPath (Join-Path $stagePath '.payload.sha256') -Encoding ASCII
    if(Test-Path -LiteralPath $payload){Remove-Item -LiteralPath $payload -Recurse -Force}
    Move-Item -LiteralPath $stagePath -Destination $payload
  }finally{if(Test-Path -LiteralPath $stagePath){Remove-Item -LiteralPath $stagePath -Recurse -Force}}
}

try{
  $hash=Assert-Payload
  if($PlanOnly){
    Write-Host "Compact target kit verified: payload SHA-256 $hash"
    if($StartOnly){
      Write-Host "Host plan: use installed manager $installedTool to run start and status with $installedConfig."
    }else{
      Write-Host 'Setup plan: fixed-account preparation, mandatory administrative pre-migration backup, migration, transactional install/update, tasks, firewall, TCP 8080 reclaim and health verification.'
      Write-Host 'Network plan: host=192.168.0.18; remote=192.168.0.0/22; protocol=TCP; port=8080; profiles=Private,Domain,Public.'
    }
    Write-Host 'PlanOnly: no files, database, services, tasks or firewall state were changed.'
    exit 0
  }
  if(Restart-ElevatedIfNeeded){exit 0}
  [IO.Directory]::CreateDirectory($logRoot)|Out-Null
  $script:logPath=Join-Path $logRoot "setup-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss')).log"
  if($StartOnly){
    if(-not(Test-Path -LiteralPath $installedTool -PathType Leaf)-or-not(Test-Path -LiteralPath $installedConfig -PathType Leaf)){throw 'WDWELT 尚未安裝；請先執行 npm.cmd run setup。'}
    Invoke-SetupProcess '啟動或確認 WDWELT host' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$installedTool,'start','-ConfigPath',$installedConfig)
    Invoke-SetupProcess '顯示 WDWELT status' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$installedTool,'status','-ConfigPath',$installedConfig)
    exit 0
  }
  Expand-VerifiedPayload $hash
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $admin=Join-Path $payload 'config\local\database.admin.json'
  $runtimeConfig=Join-Path $payload 'config\local\database.runtime.json'
  Invoke-SetupProcess '準備固定 MySQL database 與帳號' $node @((Join-Path $payload 'db\operations\target-environment.mjs'))
  Invoke-SetupProcess '安裝或更新 WDWELT' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $payload 'tools\wdwelt.ps1'),'install','-PackagePath',$payload,'-NodePath',$node,'-DatabaseConfigPath',$runtimeConfig,'-AdminDatabaseConfigPath',$admin,'-MySqlServiceName',$MySqlServiceName,'-DeploymentSettingsPath',(Join-Path $payload 'tools\deployment.json'),'-CanonicalHost','192.168.0.18','-AllowedRemoteAddress','192.168.0.0/22','-AllowPublicProfile')
  Invoke-SetupProcess '設定固定 Master Recovery Password' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $payload 'tools\target-recovery.ps1'),'-AdminConfig',$admin)
  Write-SetupLine "`nTARGET ENVIRONMENT READY: http://192.168.0.18:8080/" Green
  Write-SetupLine "Log: $logPath"
  exit 0
}catch{
  Write-Host "`n失敗階段：$stage" -ForegroundColor Red
  Write-Host "原因：$($_.Exception.Message)" -ForegroundColor Red
  if($logPath){Write-Host "完整記錄：$logPath"}
  exit 1
}
