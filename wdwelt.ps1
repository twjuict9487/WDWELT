[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('start','stop','restart','ensure','health','status','recover','network','logs','power','watchdog','boot','daily','install-tasks','install-firewall','package','install','update','rollback')]
  [string]$Command = 'status',
  [string]$ConfigPath,
  [string]$PackagePath,
  [string]$InstallPath = "$env:ProgramData\WDWELT",
  [string]$CanonicalHost,
  [string]$NodePath,
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$AllowPublicProfile
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))

function Resolve-InputPath([string]$Value, [string]$BasePath = $ScriptRoot) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path 不可為空白。' }
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path $BasePath $Value))
}

function Test-PathWithin([string]$Path, [string]$Root, [switch]$AllowEqual) {
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($AllowEqual -and $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $fullPath.StartsWith("$fullRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeInstallLayout($Candidate) {
  $installRoot = [IO.Path]::GetFullPath([string]$Candidate.installPath)
  $driveRoot = [IO.Path]::GetPathRoot($installRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($installRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "installPath 不可為磁碟根目錄：$installRoot"
  }
  foreach ($name in @('currentPath','logPath','runPath')) {
    if (-not (Test-PathWithin ([string]$Candidate.$name) $installRoot)) { throw "$name 必須位於 installPath 之內。" }
  }
}

$InstallPath = Resolve-InputPath $InstallPath
$configWasProvided = -not [string]::IsNullOrWhiteSpace($ConfigPath)
if (-not $configWasProvided) {
  $installedConfig = Join-Path $InstallPath 'config\wdwelt.json'
  if (Test-Path -LiteralPath $installedConfig) { $ConfigPath = $installedConfig }
  elseif ($Command -eq 'install') { $ConfigPath = $installedConfig }
  else { $ConfigPath = Join-Path $ScriptRoot 'g2\config.development.json' }
}
$ConfigPath = Resolve-InputPath $ConfigPath
$ConfigDirectory = Split-Path -Parent $ConfigPath

function Resolve-ConfiguredPath([string]$Value) {
  return Resolve-InputPath $Value $ConfigDirectory
}

function Read-WdweltConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "找不到設定檔：$ConfigPath" }
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
  if ([int]$config.port -ne 8080) { throw 'WDWELT production port 必須為 8080。' }
  if ([string]::IsNullOrWhiteSpace([string]$config.canonicalHost) -or [string]::IsNullOrWhiteSpace([string]$config.canonicalUrl)) { throw '設定缺少 canonicalHost/canonicalUrl。' }
  try { $canonicalUri=[Uri]$config.canonicalUrl } catch { throw 'canonicalUrl 格式不合法。' }
  if ($canonicalUri.Scheme -ne 'http' -or $canonicalUri.Port -ne 8080 -or -not $canonicalUri.Host.Equals([string]$config.canonicalHost,[StringComparison]::OrdinalIgnoreCase)) { throw 'canonicalUrl 必須是 canonicalHost 的 http://host:8080 origin。' }
  foreach($positiveName in @('healthIntervalSeconds','healthTimeoutSeconds','healthFailureThreshold','maintenanceLockMinutes','logRetentionDays','logMaxBytes')){if([double]$config.$positiveName-le0){throw "$positiveName 必須大於 0。"}}
  if([double]$config.recoveryCooldownSeconds-lt0){throw 'recoveryCooldownSeconds 不可小於 0。'}
  foreach ($name in @('installPath','currentPath','logPath','runPath')) {
    if ([string]::IsNullOrWhiteSpace([string]$config.$name)) { throw "設定缺少 $name。" }
    $config.$name = Resolve-ConfiguredPath ([string]$config.$name)
  }
  if ($config.nodePath) { $config.nodePath = Resolve-ConfiguredPath ([string]$config.nodePath) }
  Assert-SafeInstallLayout $config
  return $config
}

$Config = if ($Command -eq 'install' -and -not (Test-Path -LiteralPath $ConfigPath)) {
  [pscustomobject]@{
    port=8080; bindAddress='0.0.0.0'; canonicalHost=''; canonicalUrl=''; installPath=$InstallPath
    currentPath=(Join-Path $InstallPath 'current'); logPath=(Join-Path $InstallPath 'logs')
    runPath=(Join-Path $InstallPath 'run'); healthIntervalSeconds=60; healthTimeoutSeconds=5
    healthFailureThreshold=3; recoveryCooldownSeconds=120; maintenanceLockMinutes=15; logRetentionDays=14; logMaxBytes=5000000
  }
} else { Read-WdweltConfig }
Assert-SafeInstallLayout $Config
$PidFile = Join-Path $Config.runPath 'host.pid.json'
$ManualStopFile = Join-Path $Config.runPath 'manual-stop.json'
$LockFile = Join-Path $Config.runPath 'maintenance-lock.json'
$FailureFile = Join-Path $Config.runPath 'health-failures.json'
$DesiredFile = Join-Path $Config.runPath 'desired-state.json'

function Ensure-Directories {
  foreach ($path in @($Config.logPath, $Config.runPath)) { [IO.Directory]::CreateDirectory($path) | Out-Null }
}

function Read-Release([string]$Root = $Config.currentPath) {
  $path = Join-Path $Root 'build-metadata.json'
  if (-not (Test-Path -LiteralPath $path)) { throw "找不到 release metadata：$path" }
  try { $release = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json } catch { throw "Release metadata 無法解析：$path" }
  if ([string]::IsNullOrWhiteSpace([string]$release.version) -or [string]::IsNullOrWhiteSpace([string]$release.build)) {
    throw "Release metadata 缺少 version/build：$path"
  }
  return $release
}

function Write-OperationLog([string]$Level, [string]$Event, [string]$Message) {
  try {
    Ensure-Directories
    $release = try { Read-Release } catch { $null }
    $record = [ordered]@{ timestamp=(Get-Date).ToUniversalTime().ToString('o'); level=$Level; event=$Event; version=if($release){$release.version}else{'unknown'}; build=if($release){$release.build}else{'unknown'}; message=$Message }
    Add-Content -Encoding UTF8 -LiteralPath (Join-Path $Config.logPath 'operations.jsonl') -Value ($record | ConvertTo-Json -Compress)
  } catch { Write-Warning "無法寫入 operation log：$($_.Exception.Message)" }
}

function Write-StateFile([string]$Path, [hashtable]$Value) {
  Ensure-Directories
  $Value.timestamp = (Get-Date).ToUniversalTime().ToString('o')
  Set-Content -Encoding UTF8 -LiteralPath $Path -Value ($Value | ConvertTo-Json)
}

function Get-LanCandidates {
  $native = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' } |
    ForEach-Object {
      $adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
      [pscustomobject]@{ Address=$_.IPAddress; Interface=$_.InterfaceAlias; Description=$adapter.InterfaceDescription; Virtual=($adapter.InterfaceDescription -match 'virtual|vpn|hyper-v|vmware|tap|tunnel') }
    })
  if ($native.Count) { return $native }
  @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object OperationalStatus -eq 'Up' | ForEach-Object {
      $interface = $_
      $_.GetIPProperties().UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.IPAddressToString -ne '127.0.0.1' } | ForEach-Object {
        [pscustomobject]@{ Address=$_.Address.ToString(); Interface=$interface.Name; Description=$interface.Description; Virtual=($interface.Description -match 'virtual|vpn|hyper-v|vmware|tap|tunnel') }
      }
    })
}

function Get-PortOwner {
  $connection = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $ownerPid = if ($connection) { [int]$connection.OwningProcess } else {
    $line = netstat -ano -p TCP | Select-String -Pattern '^\s*TCP\s+\S+:8080\s+\S+\s+LISTENING\s+(\d+)\s*$' | Select-Object -First 1
    if ($line -and $line.Matches.Count) { [int]$line.Matches[0].Groups[1].Value } else { 0 }
  }
  if (-not $ownerPid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  $basic = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  [pscustomobject]@{ PID=$ownerPid; Address=if($connection){$connection.LocalAddress}else{'無法確認'}; Name=if($process){$process.Name}elseif($basic){$basic.ProcessName}else{'無法確認'}; CommandLine=if($process){$process.CommandLine}else{$null} }
}

function Get-PidRecord {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $PidFile | ConvertFrom-Json } catch { return $null }
}

function Get-VerifiedHost {
  $record = Get-PidRecord
  if (-not $record) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
  $basic = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if (-not $process -and -not $basic) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue; return $null }
  $serverPath = [IO.Path]::GetFullPath((Join-Path $Config.installPath 'tools\host\server.mjs'))
  if (-not (Test-Path -LiteralPath $serverPath)) { $serverPath = [IO.Path]::GetFullPath((Join-Path $ScriptRoot 'g2\host\server.mjs')) }
  $processName = if($process){$process.Name}else{$basic.ProcessName}
  if ($processName -notmatch '^node(\.exe)?$') { return $null }
  $commandVerified = [bool]$process.CommandLine
  if ($commandVerified -and (($process.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) -or ($process.CommandLine.IndexOf($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -lt 0))) { return $null }
  $owner = Get-PortOwner
  if ($owner -and [int]$owner.PID -ne [int]$record.pid) { return $null }
  if (-not $commandVerified) {
    $health = Invoke-Health
    if (-not $health -or $health.version -ne $record.version -or $health.build -ne $record.build -or -not $record.controlToken) { return $null }
  }
  [pscustomobject]@{ Record=$record; Process=if($process){$process}else{$basic}; PortOwner=$owner; CommandVerified=$commandVerified }
}

function Get-MaintenanceLock {
  if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
  try {
    $lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $LockFile | ConvertFrom-Json
    if ([DateTimeOffset]::Parse($lock.expiresAt) -le [DateTimeOffset]::UtcNow) {
      Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
      Write-OperationLog warning stale_lock '已清除過期 maintenance lock。'
      return $null
    }
    return $lock
  } catch { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue; return $null }
}

function Acquire-MaintenanceLock([string]$Owner) {
  $existing = Get-MaintenanceLock
  if ($existing) { throw "Maintenance lock 由 $($existing.owner) 持有，至 $($existing.expiresAt)。" }
  $expires = [DateTimeOffset]::UtcNow.AddMinutes([double]$Config.maintenanceLockMinutes).ToString('o')
  Write-StateFile $LockFile @{ owner=$Owner; expiresAt=$expires }
}
function Release-MaintenanceLock { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue }

function Invoke-Health([int]$TimeoutSeconds = [int]$Config.healthTimeoutSeconds) {
  try {
    $result = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8080/health' -TimeoutSec $TimeoutSeconds
    if ($result.status -ne 'ok' -or -not $result.version -or -not $result.build) { throw 'health response 缺少必要欄位' }
    return $result
  } catch { return $null }
}

function Set-Desired([string]$State) { Write-StateFile $DesiredFile @{ state=$State } }

function Quote-NativeArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Native process argument 不可包含雙引號。' }
  $escaped = $Value -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Start-Wdwelt {
  Ensure-Directories
  Set-Desired 'running'
  Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
  $verified = Get-VerifiedHost
  if ($verified) {
    $health = Invoke-Health
    if ($health) { Write-Host "WDWELT 已在執行：$($health.version) build $($health.build)"; return }
    throw '找到已驗證的 WDWELT process，但 health 失敗；請執行 recover。'
  }
  $owner = Get-PortOwner
  if ($owner) { throw "Port 8080 已被 PID $($owner.PID) $($owner.Name) 占用；未停止該程序。" }
  $node = if ($Config.nodePath) { [string]$Config.nodePath } else { (Get-Command node -ErrorAction Stop).Source }
  $server = Join-Path $Config.installPath 'tools\host\server.mjs'
  if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $ScriptRoot 'g2\host\server.mjs' }
  $node = Resolve-InputPath $node
  $server = Resolve-InputPath $server
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "找不到 Node runtime：$node" }
  if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "找不到 production host：$server" }
  if ($DryRun) { Write-Host "[DRY-RUN] $node $server --root $($Config.currentPath) --config $ConfigPath"; return }
  $expectedRelease = Read-Release
  $argumentLine = @($server,'--root',$Config.currentPath,'--config',$ConfigPath) | ForEach-Object { Quote-NativeArgument ([string]$_) }
  $process = Start-Process -FilePath $node -ArgumentList ($argumentLine -join ' ') -WorkingDirectory $Config.installPath -WindowStyle Hidden -PassThru
  for ($attempt=1; $attempt -le 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "WDWELT host 提前結束，exit code $($process.ExitCode)。" }
    $health = Invoke-Health 2
    if ($health -and $health.version -eq $expectedRelease.version -and $health.build -eq $expectedRelease.build) { Write-OperationLog info start "Health verified for PID $($process.Id)."; Write-Host "啟動完成：http://127.0.0.1:8080 ($($health.version) build $($health.build))"; return }
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  throw 'Host 已啟動但 health 在期限內未成功。'
}

function Stop-Wdwelt([switch]$Maintenance) {
  Ensure-Directories
  if (-not $Maintenance) { Set-Desired 'stopped'; Write-StateFile $ManualStopFile @{ reason='manual-stop' } }
  $verified = Get-VerifiedHost
  if (-not $verified) {
    $owner = Get-PortOwner
    if ($owner) { throw "Port 8080 由未驗證程序 PID $($owner.PID) 占用；未停止它。" }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'WDWELT 未在執行。'
    return
  }
  $requestPath = Join-Path $Config.runPath 'shutdown.request.json'
  Write-StateFile $requestPath @{ pid=[int]$verified.Record.pid; controlToken=[string]$verified.Record.controlToken }
  for ($attempt=1; $attempt -le 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $verified.Record.pid -ErrorAction SilentlyContinue)) { Write-OperationLog info stop "PID $($verified.Record.pid) stopped gracefully."; Write-Host 'WDWELT 已停止。'; return }
  }
  $again = Get-VerifiedHost
  if (-not $again) { throw 'Graceful stop 逾時，且 process identity 已無法驗證；未強制停止。' }
  Stop-Process -Id $again.Record.pid -Force
  Write-OperationLog warning stop "PID $($again.Record.pid) forced after graceful timeout."
  Write-Host 'WDWELT 已在 graceful timeout 後強制停止。'
}

function Restart-Wdwelt {
  Acquire-MaintenanceLock 'restart'
  try { Stop-Wdwelt -Maintenance; Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue; Start-Wdwelt } finally { Release-MaintenanceLock }
}

function Recover-Wdwelt {
  if (Test-Path -LiteralPath $ManualStopFile) { Write-Host 'Manual stop 有效；recovery 不會啟動 WDWELT。'; return }
  if (Get-MaintenanceLock) { throw '有效 maintenance lock 存在；recovery 不介入。' }
  Acquire-MaintenanceLock 'recovery'
  try {
    $health = Invoke-Health
    if ($health) { Write-Host 'WDWELT 已健康，不需要 recovery。'; return }
    $verified = Get-VerifiedHost
    if ($verified) { Stop-Wdwelt -Maintenance }
    elseif (Get-PortOwner) { throw 'Port 8080 由未知程序占用；recovery 未停止它。' }
    Read-Release | Out-Null
    Start-Wdwelt
    if (-not (Invoke-Health)) { throw 'Recovery start 後 health 仍失敗。' }
    Write-OperationLog info recovery 'Recovery completed.'
  } finally { Release-MaintenanceLock }
}

function Invoke-Watchdog([switch]$DailyReset) {
  Ensure-Directories
  $guardPath = Join-Path $Config.runPath 'watchdog.guard'
  try { $guard = [IO.File]::Open($guardPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { return }
  try {
    if ($DailyReset) { Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue; Set-Desired 'running' }
    if (Test-Path -LiteralPath $ManualStopFile) { return }
    if (Get-MaintenanceLock) { return }
    $health = Invoke-Health
    if ($health) { Remove-Item -LiteralPath $FailureFile -Force -ErrorAction SilentlyContinue; return }
    if ($DailyReset) { Recover-Wdwelt; return }
    $state = if (Test-Path -LiteralPath $FailureFile) { try { Get-Content -Raw $FailureFile | ConvertFrom-Json } catch { $null } } else { $null }
    $count = if ($state) { [int]$state.count + 1 } else { 1 }
    $lastRecovery = if ($state -and $state.lastRecovery) { [DateTimeOffset]::Parse($state.lastRecovery) } else { [DateTimeOffset]::MinValue }
    Write-StateFile $FailureFile @{ count=$count; lastRecovery=$lastRecovery.ToString('o') }
    Write-OperationLog warning health_failure "Consecutive failure $count/$($Config.healthFailureThreshold)."
    if ($count -lt [int]$Config.healthFailureThreshold) { return }
    if (([DateTimeOffset]::UtcNow - $lastRecovery).TotalSeconds -lt [double]$Config.recoveryCooldownSeconds) { return }
    try { Recover-Wdwelt } finally { Write-StateFile $FailureFile @{ count=0; lastRecovery=[DateTimeOffset]::UtcNow.ToString('o') } }
  } finally { $guard.Dispose() }
}

function Invoke-Boot {
  Remove-Item $ManualStopFile -Force -ErrorAction SilentlyContinue
  Set-Desired 'running'
  for($attempt=1;$attempt -le 6;$attempt++){
    if(Invoke-Health){return}
    try { Recover-Wdwelt; if(Invoke-Health){return} } catch { Write-OperationLog warning boot "Boot attempt $attempt failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds ([Math]::Min(10*$attempt,30))
  }
  throw 'Boot retries exhausted; WDWELT remains unhealthy.'
}

function Show-Status {
  $verified = Get-VerifiedHost
  $health = Invoke-Health
  $release = try { Read-Release } catch { $null }
  $candidates = Get-LanCandidates
  $owner = Get-PortOwner
  $lock = Get-MaintenanceLock
  $tasks = @('WDWELT Boot','WDWELT 0700','WDWELT Watchdog') | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
  $previousRelease = try { $p=Read-Release (Join-Path $Config.installPath 'previous'); "$($p.version) build $($p.build)" } catch { 'none' }
  $recentError = try { (Get-Content -Tail 100 -LiteralPath (Join-Path $Config.logPath 'operations.jsonl') | ConvertFrom-Json | Where-Object level -eq 'error' | Select-Object -Last 1).message } catch { 'none' }
  [ordered]@{
    Running=[bool]$verified; Health=if($health){'ok'}elseif($verified){'unhealthy'}else{'stopped'}; PID=if($verified){$verified.Record.pid}else{'無法確認'}
    ActualListeningAddress=if($owner){$owner.Address}else{'無法確認'}; CanonicalLanUrl=$Config.canonicalUrl
    DetectedLanIPv4Candidates=if($candidates){(($candidates|ForEach-Object Address) -join ', ')}else{'無法確認'}; Port=8080
    Version=if($health){$health.version}elseif($release){$release.version}else{'無法確認'}; Build=if($health){$health.build}elseif($release){$release.build}else{'無法確認'}
    UptimeSeconds=if($health){$health.uptimeSeconds}else{'無法確認'}; LastHealthCheck=(Get-Date).ToString('s')
    ManualStop=(Test-Path -LiteralPath $ManualStopFile); MaintenanceLock=if($lock){"$($lock.owner) until $($lock.expiresAt)"}else{'none'}
    CurrentRelease=if($release){"$($release.version) build $($release.build)"}else{'無法確認'}
    PreviousRelease=$previousRelease
    BootTask=if($tasks | Where-Object TaskName -eq 'WDWELT Boot'){'installed'}else{'not installed'}
    Daily0700Task=if($tasks | Where-Object TaskName -eq 'WDWELT 0700'){'installed'}else{'not installed'}
    WatchdogTask=if($tasks | Where-Object TaskName -eq 'WDWELT Watchdog'){'installed'}else{'not installed'}
    RecentError=$recentError
  } | Format-List
}

function Test-Network {
  $candidates = Get-LanCandidates; $owner = Get-PortOwner; $health = Invoke-Health
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
  $firewall = Get-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -ErrorAction SilentlyContinue
  $verifiedHost = Get-VerifiedHost
  $candidateAddresses=@($candidates|ForEach-Object Address)
  $canonicalIsLocal = $Config.canonicalHost -in @('127.0.0.1','localhost') -or $Config.canonicalHost -in $candidateAddresses
  $firewallEnabled = [bool]($firewall | Where-Object Enabled -eq 'True')
  Write-Host "LAN IPv4 candidates: $(if($candidates){$candidateAddresses -join ', '}else{'無法確認'})"
  if ($candidates.Count -gt 1 -or ($candidates | Where-Object Virtual)) { Write-Warning '偵測到多網卡、VPN 或虛擬網卡；canonical host 必須人工確認。' }
  if (-not $canonicalIsLocal) { Write-Warning "canonical host $($Config.canonicalHost) 不在目前 LAN IPv4 candidates。" }
  Write-Host "Port 8080: $(if($owner){"listening PID $($owner.PID) $($owner.Name)"}else{'not listening'})"
  Write-Host "Port owner verified as WDWELT: $([bool]$verifiedHost)"
  Write-Host "Localhost health: $(if($health){'ok'}else{'failed'})"
  Write-Host "Windows profiles: $(if($profiles){($profiles.NetworkCategory -join ', ')}else{'無法確認'})"
  Write-Host "Firewall rule: $(if($firewall){$firewall.Enabled}else{'not installed'})"
  if ($Config.canonicalHost -notmatch '^\d+\.\d+\.\d+\.\d+$') { try { Write-Host "Hostname resolution: $([Net.Dns]::GetHostAddresses($Config.canonicalHost) -join ', ')" } catch { Write-Warning 'Hostname 無法解析。' } }
  Write-Host "Canonical URL: $($Config.canonicalUrl)"
  if ($health -and $verifiedHost) { Write-Host '本機 WDWELT 正常。' }
  if ($health -and $verifiedHost -and $canonicalIsLocal -and $firewallEnabled) { Write-Host '本機 LAN 設定看起來可用。' }
  else { Write-Host '本機 LAN 設定尚有警告或無法確認。' }
  Write-Host '另一台裝置實際連線尚未驗證；請用同一 LAN 的手機或電腦開啟 canonical URL。'
}

function Show-Logs {
  $operationLog=Join-Path $Config.logPath 'operations.jsonl'
  $hostLog=Join-Path $Config.logPath 'wdwelt.jsonl'
  if(Test-Path $operationLog){Write-Host 'Management operations:';Get-Content -Encoding UTF8 -Tail 100 -LiteralPath $operationLog}
  if(Test-Path $hostLog){Write-Host 'Production host:';Get-Content -Encoding UTF8 -Tail 100 -LiteralPath $hostLog}
  if(-not(Test-Path $operationLog)-and-not(Test-Path $hostLog)){Write-Host '尚無 WDWELT logs。'}
}

function Show-Power([switch]$ApplySettings) {
  $ac = (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1).BatteryStatus
  Write-Host "AC power: $(if($null -eq $ac){'Desktop／無法確認'}elseif($ac -in 2,6,7,8,9){'connected'}else{'可能未接電'})"
  powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Out-Host
  powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE | Out-Host
  powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE | Out-Host
  powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION | Out-Host
  if($LASTEXITCODE-ne0){Write-Host 'Lid-close action: 無法確認（此硬體或 power plan 未公開該設定）。'}
  $dailyTask=Get-ScheduledTask -TaskName 'WDWELT 0700' -ErrorAction SilentlyContinue
  Write-Host "WDWELT 07:00 task WakeToRun: $(if($dailyTask){$dailyTask.Settings.WakeToRun}else{'task not installed／無法確認'})"
  Write-Host 'Task Scheduler 只在 Windows 已開機時可靠執行；wake timer 視硬體與 Windows 而定，完全 shutdown 無法保證 07:00 開機。'
  if ($ApplySettings) {
    Write-Host '將只修改 AC：停用 sleep/hibernate，啟用 wake timer；不修改 battery 或 BIOS/UEFI。'
    if (-not $Apply) { throw '實際修改需要同時指定 power -Apply。' }
    powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1; powercfg /setactive SCHEME_CURRENT
  }
}

function Install-Tasks {
  $taskScript = Join-Path $Config.installPath 'tools\wdwelt.ps1'
  if (-not (Test-Path -LiteralPath $taskScript -PathType Leaf)) { $taskScript = $PSCommandPath }
  $specs = @(
    @{Name='WDWELT Boot'; Trigger='ONSTART'; Modifier=$null; Cmd="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$taskScript`" boot -ConfigPath `"$ConfigPath`""},
    @{Name='WDWELT 0700'; Trigger='DAILY'; Modifier=$null; Cmd="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$taskScript`" daily -ConfigPath `"$ConfigPath`""},
    @{Name='WDWELT Watchdog'; Trigger='MINUTE'; Modifier=[string][Math]::Max(1,[Math]::Ceiling([int]$Config.healthIntervalSeconds / 60)); Cmd="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$taskScript`" watchdog -ConfigPath `"$ConfigPath`""}
  )
  foreach($spec in $specs) {
    $args = @('/Create','/TN',$spec.Name,'/TR',$spec.Cmd,'/SC',$spec.Trigger,'/F','/RL','HIGHEST','/RU','SYSTEM')
    if($spec.Name -eq 'WDWELT 0700'){ $args += @('/ST','07:00') }
    if($spec.Modifier){ $args += @('/MO',$spec.Modifier) }
    if($DryRun){ Write-Host "[DRY-RUN] schtasks.exe $($args -join ' '); MultipleInstances=IgnoreNew; WakeToRun=$($spec.Name -eq 'WDWELT 0700')" } else {
      & schtasks.exe @args; if($LASTEXITCODE -ne 0){throw "Task install failed: $($spec.Name)"}
      $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -WakeToRun:($spec.Name -eq 'WDWELT 0700') -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
      Set-ScheduledTask -TaskName $spec.Name -Settings $settings | Out-Null
    }
  }
}

function Install-Firewall {
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
  if (($profiles.NetworkCategory -contains 'Public') -and -not $AllowPublicProfile) { throw '目前包含 Public network profile；需明確指定 -AllowPublicProfile 才會建立規則。' }
  if ($DryRun) { Write-Host '[DRY-RUN] Ensure firewall rule WDWELT LAN TCP 8080, TCP 8080, LocalSubnet, Private/Domain.'; return }
  Get-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $firewallProfiles = if($AllowPublicProfile){'Private','Domain','Public'}else{'Private','Domain'}
  New-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -RemoteAddress LocalSubnet -Profile $firewallProfiles -Action Allow | Out-Null
}

function Invoke-Package {
  if (-not (Test-Path -LiteralPath (Join-Path $ScriptRoot 'dist\build-metadata.json'))) { throw '請先執行 npm run build。' }
  $output = if($PackagePath){Resolve-InputPath $PackagePath}else{Join-Path $ScriptRoot 'artifacts\wdwelt-package'}
  $output = [IO.Path]::GetFullPath($output)
  $outputRoot = [IO.Path]::GetPathRoot($output).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($output.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($outputRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $output.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($ScriptRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒絕將 package 輸出到不安全位置：$output"
  }
  if(Test-Path $output){
    $existingManifest=Join-Path $output 'manifest.json'
    if(-not(Test-Path $existingManifest)){throw "拒絕覆寫非 WDWELT package directory：$output"}
    try{$existing=Get-Content -Raw -Encoding UTF8 $existingManifest|ConvertFrom-Json}catch{throw '既有 package manifest 無法驗證，拒絕覆寫。'}
    if([int]$existing.formatVersion -ne 1){throw '既有目錄不是可確認的 WDWELT package，拒絕覆寫。'}
    $unexpected = @(Get-ChildItem -LiteralPath $output -Force | Where-Object Name -notin @('production','host','tools','manifest.json'))
    if ($unexpected.Count) { throw "Package directory 含有不屬於 WDWELT package 的項目，拒絕覆寫：$($unexpected.Name -join ', ')" }
    Remove-Item -LiteralPath $output -Recurse -Force
  }
  [IO.Directory]::CreateDirectory((Join-Path $output 'production'))|Out-Null; [IO.Directory]::CreateDirectory((Join-Path $output 'host'))|Out-Null; [IO.Directory]::CreateDirectory((Join-Path $output 'tools'))|Out-Null
  Copy-Item (Join-Path $ScriptRoot 'dist\*') (Join-Path $output 'production') -Recurse
  Copy-Item (Join-Path $ScriptRoot 'g2\host\*') (Join-Path $output 'host') -Recurse
  Copy-Item $PSCommandPath (Join-Path $output 'tools\wdwelt.ps1')
  $release=Read-Release (Join-Path $output 'production')
  $files=@(Get-ChildItem (Join-Path $output 'production'),(Join-Path $output 'host'),(Join-Path $output 'tools') -File -Recurse | ForEach-Object { @{path=$_.FullName.Substring($output.Length+1).Replace('\','/');sha256=(Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()} })
  @{formatVersion=1;version=$release.version;build=$release.build;createdAt=(Get-Date).ToUniversalTime().ToString('o');productionDirectory='production';hostDirectory='host';toolsDirectory='tools';files=$files}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $output 'manifest.json')
  Write-Host "Package created: $output"
}

function Validate-Package([string]$Path) {
  $root=Resolve-InputPath $Path
  if(-not(Test-Path -LiteralPath $root -PathType Container)){throw "找不到 package directory：$root"}
  $manifestPath=Join-Path $root 'manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'Package 缺少 manifest.json。'}
  try { $manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath|ConvertFrom-Json } catch { throw 'Package manifest 無法解析。' }
  if ([int]$manifest.formatVersion -ne 1) { throw 'Package manifest formatVersion 不支援。' }
  if ($manifest.productionDirectory -ne 'production' -or $manifest.hostDirectory -ne 'host' -or $manifest.toolsDirectory -ne 'tools') { throw 'Package directory layout 不合法。' }
  $productionRoot=Join-Path $root 'production';$hostRoot=Join-Path $root 'host';$toolsRoot=Join-Path $root 'tools'
  $release=Read-Release $productionRoot
  if($manifest.version -ne $release.version -or $manifest.build -ne $release.build){throw 'Package manifest 與 build metadata 不一致。'}
  foreach ($required in @((Join-Path $productionRoot 'index.html'),(Join-Path $productionRoot 'build-metadata.json'),(Join-Path $hostRoot 'server.mjs'),(Join-Path $toolsRoot 'wdwelt.ps1'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Package 缺少必要檔案：$required" }
  }
  $manifestFiles=@($manifest.files)
  if (-not $manifestFiles.Count) { throw 'Package manifest files 不可為空。' }
  $declared=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($file in $manifestFiles){
    $relative=[string]$file.path
    if([string]::IsNullOrWhiteSpace($relative)-or[IO.Path]::IsPathRooted($relative)){throw 'Package manifest 含有不合法路徑。'}
    $target=[IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))))
    $inAllowedDirectory=(Test-PathWithin $target $productionRoot)-or(Test-PathWithin $target $hostRoot)-or(Test-PathWithin $target $toolsRoot)
    if(-not(Test-PathWithin $target $root)-or-not $inAllowedDirectory){throw "Package manifest path 越界：$relative"}
    if(-not $declared.Add($target)){throw "Package manifest path 重複：$relative"}
    if(-not(Test-Path -LiteralPath $target -PathType Leaf)){throw "Package 缺少 $relative。"}
    if(([string]$file.sha256)-notmatch '^[0-9a-fA-F]{64}$'){throw "Package checksum 格式不合法：$relative"}
    $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
    if($hash-ne([string]$file.sha256).ToLowerInvariant()){throw "Package checksum 失敗：$relative"}
  }
  $actualFiles=@(Get-ChildItem -LiteralPath $productionRoot,$hostRoot,$toolsRoot -File -Recurse)
  if($actualFiles.Count-ne$declared.Count-or($actualFiles|Where-Object{-not $declared.Contains($_.FullName)})){throw 'Package 內含未列入 manifest 的檔案。'}
  [pscustomobject]@{Root=$root;Manifest=$manifest;Release=$release}
}

function Test-Administrator { $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

function Invoke-Install {
  $packageInput=$PackagePath
  if(-not $packageInput){
    $packageCandidate=Split-Path -Parent $ScriptRoot
    if(Test-Path -LiteralPath (Join-Path $packageCandidate 'manifest.json') -PathType Leaf){$packageInput=$packageCandidate}
    else{throw 'install 需要 -PackagePath；若從 production package 的 tools\wdwelt.ps1 執行，則可自動偵測 package root。'}
  }
  $package=Validate-Package $packageInput
  $installedConfig=Join-Path $InstallPath 'config\wdwelt.json'
  if(-not $ConfigPath.Equals($installedConfig,[StringComparison]::OrdinalIgnoreCase)){throw "install 的 ConfigPath 必須是目標安裝設定：$installedConfig"}
  $existingInstall=Test-Path -LiteralPath $installedConfig -PathType Leaf
  if($existingInstall){
    $chosen=[string]$Config.canonicalHost
    if($CanonicalHost -and -not $CanonicalHost.Equals($chosen,[StringComparison]::OrdinalIgnoreCase)){throw "既有 canonical host 是 $chosen；重複安裝不得更改 browser origin。"}
    if(-not $Config.installPath.Equals($InstallPath,[StringComparison]::OrdinalIgnoreCase)){throw '既有 config 的 installPath 與 -InstallPath 不一致。'}
  }else{
    $candidates=Get-LanCandidates
    $chosen=$CanonicalHost
    if(-not $chosen){if($candidates.Count -eq 1){$chosen=$candidates[0].Address}else{throw "偵測到 $($candidates.Count) 個 LAN IPv4 candidates；請以 -CanonicalHost 明確指定。"}}
  }
  if(-not $DryRun -and -not(Test-Administrator)){throw '安裝需要 Administrator 權限。'}
  $windowsVersion=[Environment]::OSVersion.VersionString
  $nodeExecutable=if($NodePath){Resolve-InputPath $NodePath}elseif($existingInstall -and $Config.nodePath){[string]$Config.nodePath}else{(Get-Command node -ErrorAction SilentlyContinue).Source}
  if(-not $nodeExecutable -or -not(Test-Path -LiteralPath $nodeExecutable -PathType Leaf)){throw '找不到 Node runtime；請由使用者明確安裝或以 -NodePath 提供可執行 Node host 的 runtime。'}
  Write-Host "Windows: $windowsVersion; Node: $(& $nodeExecutable --version)"
  Write-Host "Install $($package.Release.version) build $($package.Release.build) to $InstallPath; canonical URL http://${chosen}:8080"
  if($DryRun){Write-Host "[DRY-RUN] $(if($existingInstall){'驗證既有安裝，必要時透過 update 切換 release；保留 canonical URL 與 port。'}else{'建立全新安裝。'})";Write-Host '[DRY-RUN] 不會建立目錄、Task Scheduler task、Firewall rule 或啟動程序。';return}
  foreach($dir in @('config','logs','run','tools')){[IO.Directory]::CreateDirectory((Join-Path $InstallPath $dir))|Out-Null}
  if($existingInstall){
    $currentRelease=Read-Release $Config.currentPath
    $hostMissing=-not(Test-Path -LiteralPath (Join-Path $Config.installPath 'tools\host\server.mjs') -PathType Leaf)
    if($hostMissing){throw '既有安裝缺少 production host；為避免建立無法 rollback 的狀態，未覆寫 release。'}
    if($currentRelease.version -ne $package.Release.version -or $currentRelease.build -ne $package.Release.build){
      $PackagePath=$package.Root
      Invoke-Update
    }else{Write-Host '既有安裝已是相同 version/build；不重寫 current release。'}
    if($NodePath){
      $savedConfig=Get-Content -Raw -Encoding UTF8 -LiteralPath $installedConfig|ConvertFrom-Json
      $savedConfig.nodePath=$nodeExecutable
      $savedConfig|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $installedConfig
    }
  }else{
    $current=Join-Path $InstallPath 'current';$hostCurrent=Join-Path $InstallPath 'tools\host'
    if(Test-Path -LiteralPath $current){
      $entries=@(Get-ChildItem -LiteralPath $current -Force)
      if($entries.Count){$partial=Read-Release $current;if($partial.version-ne$package.Release.version-or$partial.build-ne$package.Release.build){throw 'InstallPath 含有沒有 config 的不同 release；拒絕覆寫。'}}
      else{Remove-Item -LiteralPath $current -Force}
    }
    if(-not(Test-Path -LiteralPath $current)){Copy-Item -LiteralPath (Join-Path $package.Root 'production') -Destination $current -Recurse}
    if(Test-Path -LiteralPath $hostCurrent){Remove-Item -LiteralPath $hostCurrent -Recurse -Force}
    Copy-Item -LiteralPath (Join-Path $package.Root 'host') -Destination $hostCurrent -Recurse
    $installed=[ordered]@{port=8080;bindAddress='0.0.0.0';canonicalHost=$chosen;canonicalUrl="http://${chosen}:8080";installPath=$InstallPath;currentPath=$current;logPath=(Join-Path $InstallPath 'logs');runPath=(Join-Path $InstallPath 'run');nodePath=$nodeExecutable;healthIntervalSeconds=60;healthTimeoutSeconds=5;healthFailureThreshold=3;recoveryCooldownSeconds=120;maintenanceLockMinutes=15;logRetentionDays=14;logMaxBytes=5000000}
    $installed|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $installedConfig
  }
  Copy-Item -LiteralPath (Join-Path $package.Root 'tools\wdwelt.ps1') -Destination (Join-Path $InstallPath 'tools\wdwelt.ps1') -Force
  $installedTool=Join-Path $InstallPath 'tools\wdwelt.ps1'
  & $installedTool install-tasks -ConfigPath $installedConfig; if($LASTEXITCODE-ne0){throw 'Task Scheduler 安裝失敗。'}
  & $installedTool install-firewall -ConfigPath $installedConfig -AllowPublicProfile:$AllowPublicProfile; if($LASTEXITCODE-ne0){throw 'Firewall rule 安裝失敗。'}
  & $installedTool start -ConfigPath $installedConfig; if($LASTEXITCODE-ne0){throw 'WDWELT 啟動或 health 驗證失敗。'}
  & $installedTool status -ConfigPath $installedConfig
  Write-Host "安裝成功：http://${chosen}:8080"
}

function Invoke-Update {
  if(-not $PackagePath){throw 'update 需要 -PackagePath。'}; $package=Validate-Package $PackagePath
  $transaction=[guid]::NewGuid().ToString('n');$stage=Join-Path $Config.runPath "stage-$transaction"
  $current=Join-Path $Config.installPath 'current';$previous=Join-Path $Config.installPath 'previous';$hostCurrent=Join-Path $Config.installPath 'tools\host';$hostPrevious=Join-Path $Config.runPath 'previous-host'
  $failed=Join-Path $Config.runPath 'failed-release';$failedHost=Join-Path $Config.runPath 'failed-host';$oldPrevious=Join-Path $Config.runPath "old-previous-$transaction";$oldPreviousHost=Join-Path $Config.runPath "old-previous-host-$transaction"
  $original=Read-Release $current
  if(-not(Test-Path -LiteralPath (Join-Path $hostCurrent 'server.mjs') -PathType Leaf)){throw 'Current production host 不完整；update 未停止服務。'}
  $lockAcquired=$false;$serviceStopped=$false;$currentPreserved=$false;$newProductionActive=$false;$hostPreserved=$false;$newHostActive=$false;$preserveArtifacts=$false
  try {
    [IO.Directory]::CreateDirectory($stage)|Out-Null
    Copy-Item -LiteralPath (Join-Path $package.Root 'production') -Destination (Join-Path $stage 'production') -Recurse
    Copy-Item -LiteralPath (Join-Path $package.Root 'host') -Destination (Join-Path $stage 'host') -Recurse
    Acquire-MaintenanceLock 'update';$lockAcquired=$true
    Stop-Wdwelt -Maintenance;$serviceStopped=$true
    if(Test-Path -LiteralPath $previous){Move-Item -LiteralPath $previous -Destination $oldPrevious}
    if(Test-Path -LiteralPath $hostPrevious){Move-Item -LiteralPath $hostPrevious -Destination $oldPreviousHost}
    Move-Item -LiteralPath $current -Destination $previous;$currentPreserved=$true
    Move-Item -LiteralPath (Join-Path $stage 'production') -Destination $current;$newProductionActive=$true
    Move-Item -LiteralPath $hostCurrent -Destination $hostPrevious;$hostPreserved=$true
    Move-Item -LiteralPath (Join-Path $stage 'host') -Destination $hostCurrent;$newHostActive=$true
    Start-Wdwelt;$health=Invoke-Health
    if(-not $health -or $health.version -ne $package.Release.version -or $health.build -ne $package.Release.build){throw '新版 health version/build 驗證失敗。'}
    Copy-Item -LiteralPath (Join-Path $package.Root 'tools\wdwelt.ps1') -Destination (Join-Path $Config.installPath 'tools\wdwelt.ps1') -Force
    Write-OperationLog info update "Activated $($health.version) build $($health.build)."
  }catch{
    $updateError=$_.Exception.Message
    if(-not $serviceStopped){throw}
    try{
      if(Get-VerifiedHost){Stop-Wdwelt -Maintenance}
      if($newHostActive -and (Test-Path -LiteralPath $hostCurrent)){
        if(Test-Path -LiteralPath $failedHost){Remove-Item -LiteralPath $failedHost -Recurse -Force}
        Move-Item -LiteralPath $hostCurrent -Destination $failedHost
      }
      if($hostPreserved -and (Test-Path -LiteralPath $hostPrevious)){Move-Item -LiteralPath $hostPrevious -Destination $hostCurrent}
      if($newProductionActive -and (Test-Path -LiteralPath $current)){
        if(Test-Path -LiteralPath $failed){Remove-Item -LiteralPath $failed -Recurse -Force}
        Move-Item -LiteralPath $current -Destination $failed
      }
      if($currentPreserved -and (Test-Path -LiteralPath $previous)){Move-Item -LiteralPath $previous -Destination $current}
      if(Test-Path -LiteralPath $oldPrevious){Move-Item -LiteralPath $oldPrevious -Destination $previous}
      if(Test-Path -LiteralPath $oldPreviousHost){Move-Item -LiteralPath $oldPreviousHost -Destination $hostPrevious}
      Start-Wdwelt;$restored=Invoke-Health
      if(-not $restored -or $restored.version -ne $original.version -or $restored.build -ne $original.build){throw 'Original release health/version verification failed.'}
    }catch{$preserveArtifacts=$true;throw "Update failed; previous release restore also failed. Releases and logs were preserved. Cause: $updateError; restore error: $($_.Exception.Message)"}
    throw "Update failed; previous release restored. Cause: $updateError"
  }finally{
    if($lockAcquired){Release-MaintenanceLock}
    if(-not $preserveArtifacts){
      foreach($temporary in @($stage,$oldPrevious,$oldPreviousHost)){if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue}}
    }
  }
}

function Switch-DirectoryPair([string]$Current,[string]$Previous,[string]$Swap) {
  if(-not(Test-Path -LiteralPath $Current -PathType Container)-or-not(Test-Path -LiteralPath $Previous -PathType Container)){throw 'Release pair 不完整，無法安全切換。'}
  if(Test-Path -LiteralPath $Swap){throw "Swap directory 已存在：$Swap"}
  Move-Item -LiteralPath $Current -Destination $Swap
  try{
    Move-Item -LiteralPath $Previous -Destination $Current
    Move-Item -LiteralPath $Swap -Destination $Previous
  }catch{
    $switchError=$_.Exception.Message
    try{
      if((Test-Path -LiteralPath $Current)-and-not(Test-Path -LiteralPath $Previous)){Move-Item -LiteralPath $Current -Destination $Previous}
      if((Test-Path -LiteralPath $Swap)-and-not(Test-Path -LiteralPath $Current)){Move-Item -LiteralPath $Swap -Destination $Current}
    }catch{throw "Directory switch failed and its state could not be restored: $switchError; restore error: $($_.Exception.Message)"}
    throw "Directory switch failed; original pair restored: $switchError"
  }
}

function Invoke-Rollback {
  $current=Join-Path $Config.installPath 'current';$previous=Join-Path $Config.installPath 'previous'
  $currentRelease=Read-Release $current
  if(-not(Test-Path $previous)){throw "目前 $($currentRelease.version) build $($currentRelease.build)；沒有 previous release，未停止服務。"}
  $previousRelease=Read-Release $previous
  $hostCurrent=Join-Path $Config.installPath 'tools\host';$hostPrevious=Join-Path $Config.runPath 'previous-host'
  if(-not(Test-Path -LiteralPath (Join-Path $hostPrevious 'server.mjs') -PathType Leaf)){throw 'Previous release 缺少對應 production host，未停止服務。'}
  Write-Host "Current: $($currentRelease.version) build $($currentRelease.build); Previous: $($previousRelease.version) build $($previousRelease.build)"
  Acquire-MaintenanceLock 'rollback';$swap=Join-Path $Config.runPath 'rollback-swap';$hostSwap=Join-Path $Config.runPath 'host-swap';$releaseSwitched=$false;$hostSwitched=$false
  if((Test-Path -LiteralPath $swap)-or(Test-Path -LiteralPath $hostSwap)){Release-MaintenanceLock;throw '發現 stale rollback swap directory；為避免覆寫 release，未停止服務。'}
  try {
    try {
      Stop-Wdwelt -Maintenance
      Switch-DirectoryPair $current $previous $swap;$releaseSwitched=$true
      Switch-DirectoryPair $hostCurrent $hostPrevious $hostSwap;$hostSwitched=$true
      Start-Wdwelt;$health=Invoke-Health
      if(-not $health-or$health.version-ne$previousRelease.version-or$health.build-ne$previousRelease.build){throw 'Rollback health/version verification failed.'}
      Write-OperationLog info rollback 'Manual rollback completed.'
    }catch{
      $rollbackError=$_.Exception.Message
      if(-not $releaseSwitched){throw}
      try{
        if(Get-VerifiedHost){Stop-Wdwelt -Maintenance}
        if($hostSwitched){Switch-DirectoryPair $hostCurrent $hostPrevious $hostSwap}
        Switch-DirectoryPair $current $previous $swap
        Start-Wdwelt;$restored=Invoke-Health
        if(-not $restored-or$restored.version-ne$currentRelease.version-or$restored.build-ne$currentRelease.build){throw 'Original release health/version verification failed.'}
      }catch{throw "Rollback failed and original release restore also failed: $rollbackError; restore error: $($_.Exception.Message)"}
      throw "Rollback failed; original release restored. Cause: $rollbackError"
    }
  }finally{Release-MaintenanceLock}
}

try {
  switch($Command){
    start {Start-Wdwelt}; stop {Stop-Wdwelt}; restart {Restart-Wdwelt}; ensure {if(-not(Test-Path $ManualStopFile)-and-not(Invoke-Health)){Recover-Wdwelt}}
    health {$health=Invoke-Health;if(-not $health){throw 'Health check failed.'};$health|ConvertTo-Json}
    status {Show-Status}; recover {Recover-Wdwelt}; network {Test-Network}; logs {Show-Logs}
    power {Show-Power -ApplySettings:$Apply}; watchdog {Invoke-Watchdog}; boot {Invoke-Boot}
    daily {Invoke-Watchdog -DailyReset}; install-tasks {Install-Tasks}; install-firewall {Install-Firewall}; package {Invoke-Package}; install {Invoke-Install}; update {Invoke-Update}; rollback {Invoke-Rollback}
  }
  exit 0
} catch {
  if(-not $DryRun){Write-OperationLog error $Command $_.Exception.Message}
  Write-Error $_.Exception.Message
  exit 1
}
