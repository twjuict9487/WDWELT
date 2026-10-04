[CmdletBinding()]
param(
  [switch]$PlanOnly,
  [switch]$Diagnose,
  [switch]$FullValidation,
  [switch]$ForceDependencies,
  [string]$MySqlServiceName='MySQL80'
)
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot=Join-Path $repository 'runtime'
$logRoot=Join-Path $runtimeRoot 'logs'
$logPath=$null
$lastErrorPath=Join-Path $logRoot 'LAST-ERROR.txt'
$stage='啟動固定環境安裝器'
Set-Location -LiteralPath $repository

function Test-Administrator {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-TargetLine([string]$Message,[ConsoleColor]$Color=[ConsoleColor]::Gray) {
  Write-Host $Message -ForegroundColor $Color
  if($script:logPath){Add-Content -LiteralPath $script:logPath -Encoding UTF8 -Value $Message}
}

function Invoke-TargetProcess([string]$Stage,[string]$FilePath,[string[]]$Arguments) {
  $script:stage=$Stage
  Write-TargetLine "`n[$Stage]" Cyan
  $previousErrorPreference=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $script:logPath -Append | ForEach-Object { Write-Host $_ }
    $exitCode=$LASTEXITCODE
  } finally {$ErrorActionPreference=$previousErrorPreference}
  if($exitCode-ne0){
    $lines=@(Get-Content -LiteralPath $script:logPath -Encoding UTF8|Where-Object{$_})
    $lastOutput=$lines|Where-Object{$_ -match '安裝停止|失敗|failed|error|拒絕|找不到|denied'}|Select-Object -Last 1
    if(-not $lastOutput){$lastOutput=$lines|Select-Object -Last 1}
    throw "$Stage 失敗（exit code $exitCode）。最後輸出：$lastOutput"
  }
}

function Get-NextAction([string]$Stage,[string]$Message) {
  if($Message-match 'npm|dependency|npm-cli'){return '確認 Node.js LTS 包含 npm，並確認可連線 npm registry；若 node_modules 已損壞，使用 -ForceDependencies 重跑。'}
  if($Message-match 'MySQL|database|wdwelt_app|root'){return "在 Services 確認 $MySqlServiceName 正在執行，並確認 root 密碼仍是目標環境設定值。"}
  if($Message-match '8080|Port|PID|process'){return '以系統管理員 PowerShell 執行 -Diagnose，查看目前 8080 PID；若是受保護的系統程序，必須先由 Windows 管理員解除其服務。'}
  if($Message-match 'network|網路|gateway|192\.168\.0\.18'){return '確認有線網卡已設定 192.168.0.18/22、gateway 192.168.1.254，且網路設定檔為 Private 或 Domain。'}
  if($Message-match 'denied|拒絕|policy|AppLocker|WDAC|administrator|權限'){return '確認已允許 UAC，並請裝置管理員檢查 AppLocker、WDAC 或執行原則；專案不能覆寫 Windows 裝置政策。'}
  if($Stage-match 'production|安裝|更新'){return '先執行同一入口加上 -Diagnose，再重跑；更新交易失敗時既有可用版本會保留或復原。'}
  return '依下方原始錯誤修正後，重跑同一條安裝命令；不需要先刪除既有安裝。'
}

function Write-FailureSummary([System.Management.Automation.ErrorRecord]$Failure) {
  [IO.Directory]::CreateDirectory($script:logRoot)|Out-Null
  $message=$Failure.Exception.Message
  $action=Get-NextAction $script:stage $message
  $tail=if($script:logPath -and (Test-Path -LiteralPath $script:logPath)){@(Get-Content -LiteralPath $script:logPath -Encoding UTF8|Where-Object{$_}|Select-Object -Last 30)}else{@()}
  $summary=@(
    'WDWELT 固定環境安裝失敗',
    "時間：$([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))",
    "失敗階段：$script:stage",
    "原因：$message",
    "下一步：$action",
    "完整記錄：$script:logPath",
    '',
    '最後輸出：'
  )+$tail
  $summary|Set-Content -LiteralPath $script:lastErrorPath -Encoding UTF8
  Write-Host "`n失敗階段：$script:stage" -ForegroundColor Red
  Write-Host "原因：$message" -ForegroundColor Red
  Write-Host "下一步：$action" -ForegroundColor Yellow
  Write-Host "可直接交給維護人員：$script:lastErrorPath"
  Write-Host "完整記錄：$script:logPath"
}

function Show-Diagnostics {
  Write-Host 'WDWELT 固定環境快速診斷' -ForegroundColor Cyan
  Write-Host "Repository：$repository"
  $node=Get-Command node.exe -ErrorAction SilentlyContinue
  Write-Host "Node：$(if($node){$node.Source}else{'找不到'})"
  $service=Get-Service -Name $MySqlServiceName -ErrorAction SilentlyContinue
  Write-Host "MySQL service：$(if($service){"$($service.Name) / $($service.Status)"}else{'找不到'})"
  $connection=Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1
  if($connection){
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
    Write-Host "TCP 8080：PID $($connection.OwningProcess) / $(if($process){$process.Name}else{'名稱無法確認'}) / $($connection.LocalAddress)"
    if($process -and $process.CommandLine){Write-Host "Command：$($process.CommandLine)"}
  }else{Write-Host 'TCP 8080：目前無 LISTENING 程序'}
  $installedConfig=Join-Path $env:ProgramData 'WDWELT\config.json'
  $installedTool=Join-Path $env:ProgramData 'WDWELT\tools\wdwelt.ps1'
  if((Test-Path -LiteralPath $installedConfig -PathType Leaf)-and(Test-Path -LiteralPath $installedTool -PathType Leaf)){
    Write-Host "Installed config：$installedConfig"
    & $installedTool status -ConfigPath $installedConfig
    & $installedTool network -ConfigPath $installedConfig
  }else{Write-Host 'Installed WDWELT：尚未找到完整安裝'}
  if(Test-Path -LiteralPath $lastErrorPath -PathType Leaf){Write-Host "最近錯誤摘要：$lastErrorPath"}
}

if($PlanOnly){
  $deployment=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repository 'config\deployment.json')|ConvertFrom-Json
  Write-Host "Target setup/update: http://$($deployment.hostAddress):8080/; MySQL service: $MySqlServiceName"
  Write-Host 'Actions: reuse or install locked dependencies, prepare fixed MySQL accounts, build/package, transactional install/update, install startup/watchdog tasks, reclaim TCP 8080, verify host, set master recovery password.'
  Write-Host 'Failure output: runtime\logs\LAST-ERROR.txt contains stage, cause, next action and log tail.'
  Write-Host 'PlanOnly: no files, database, services, tasks or firewall were changed.'
  $global:LASTEXITCODE=0
  return
}
if($Diagnose){
  try{Show-Diagnostics;$global:LASTEXITCODE=0}
  catch{$script:stage='執行快速診斷';Write-FailureSummary $_;$global:LASTEXITCODE=1}
  return
}

if(-not(Test-Administrator)){
  $script:stage='確認 Administrator 權限'
  try{throw '請由根目錄的 INSTALL-TARGET-ENVIRONMENT.ps1 啟動，讓入口處理 UAC。'}catch{Write-FailureSummary $_}
  $global:LASTEXITCODE=1
  return
}

try {
  [IO.Directory]::CreateDirectory($logRoot)|Out-Null
  $script:logPath=Join-Path $logRoot "target-setup-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss')).log"
  if(Test-Path -LiteralPath $lastErrorPath){Remove-Item -LiteralPath $lastErrorPath -Force}
  Write-TargetLine "WDWELT fixed target install/update started: $([DateTimeOffset]::Now.ToString('o'))"
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $npmCli=Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
  if(-not(Test-Path -LiteralPath $npmCli -PathType Leaf)){throw '找不到 npm-cli.js；請重新安裝包含 npm 的 Node.js LTS。'}

  $lockPath=Join-Path $repository 'package-lock.json'
  $stampPath=Join-Path $repository 'node_modules\.wdwelt-package-lock.sha256'
  $lockHash=(Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
  $dependenciesReady=(-not $ForceDependencies) -and (Test-Path -LiteralPath $stampPath -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $stampPath).Trim() -eq $lockHash) -and (Test-Path -LiteralPath (Join-Path $repository 'node_modules\vite\package.json')) -and (Test-Path -LiteralPath (Join-Path $repository 'node_modules\mysql2\package.json'))
  if($dependenciesReady){Write-TargetLine '[Dependencies] package-lock 未變更，沿用已驗證的 node_modules。' DarkGray}
  else{
    Invoke-TargetProcess '安裝鎖定的 JavaScript dependencies' $node @($npmCli,'ci','--include=dev','--no-audit','--fund=false')
    $lockHash|Set-Content -LiteralPath $stampPath -Encoding ASCII
  }

  Invoke-TargetProcess '準備固定 MySQL database 與帳號' $node @((Join-Path $repository 'db\operations\target-environment.mjs'))
  $bootstrapArguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'bootstrap.ps1'),'-ExistingAccounts','-NonInteractive','-DependenciesReady','-MySqlServiceName',$MySqlServiceName)
  if($FullValidation){$bootstrapArguments+='-FullValidation'}
  Invoke-TargetProcess '建置並安裝或更新 WDWELT' 'powershell.exe' $bootstrapArguments
  Invoke-TargetProcess '設定固定主復原密碼' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'target-recovery.ps1'))
  Write-TargetLine "`nTARGET ENVIRONMENT READY: http://192.168.0.18:8080/" Green
  Write-TargetLine "Log: $logPath"
  $global:LASTEXITCODE=0
  return
} catch {
  Write-FailureSummary $_
  $global:LASTEXITCODE=1
  return
}
