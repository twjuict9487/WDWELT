[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('start','stop','restart','ensure','health','status','recover','network','logs','power','watchdog','boot','daily','backup','restore','install-tasks','install-firewall','package','install','update','rollback')]
  [string]$Command = 'status',
  [string]$ConfigPath,
  [string]$PackagePath,
  [string]$InstallPath = "$env:ProgramData\WDWELT",
  [string]$CanonicalHost,
  [string]$DeploymentSettingsPath,
  [string[]]$AllowedRemoteAddress,
  [string]$NodePath,
  [string]$DatabaseConfigPath,
  [string]$AdminDatabaseConfigPath,
  [string]$MySqlServiceName = 'MySQL80',
  [string]$BackupFile,
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$AllowPublicProfile
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$sourceCandidate = [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..'))
$SourceRoot = if (Test-Path -LiteralPath (Join-Path $sourceCandidate 'package.json') -PathType Leaf) { $sourceCandidate } else { $ScriptRoot }
$ProductionCanonicalHost = $null
$ProductionPrefixLength = 0
$ProductionSubnet = $null
$ProductionGateway = $null
$ProductionAllowedRemoteAddresses = @()
$DeploymentEnvironmentName = $null

function Resolve-InputPath([string]$Value, [string]$BasePath = $SourceRoot) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path 不可為空白。' }
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path $BasePath $Value))
}

function Convert-DeploymentIPv4ToNumber([Net.IPAddress]$Address) {
  $bytes=$Address.GetAddressBytes()
  return [uint64]$bytes[0]*16777216+[uint64]$bytes[1]*65536+[uint64]$bytes[2]*256+[uint64]$bytes[3]
}

function Get-DeploymentPrivateMinimumPrefix([Net.IPAddress]$Address) {
  $bytes=$Address.GetAddressBytes()
  if($bytes[0]-eq10){return 8};if($bytes[0]-eq172-and$bytes[1]-ge16-and$bytes[1]-le31){return 12};if($bytes[0]-eq192-and$bytes[1]-eq168){return 16};return 0
}

function Read-DeploymentSettings {
  if([string]::IsNullOrWhiteSpace($DeploymentSettingsPath)){
    $sourceSettings=Join-Path $SourceRoot 'config\deployment.json';$packagedSettings=Join-Path $ScriptRoot 'deployment.json'
    $resolved=if(Test-Path -LiteralPath $sourceSettings -PathType Leaf){$sourceSettings}else{$packagedSettings}
  }else{$resolved=Resolve-InputPath $DeploymentSettingsPath}
  if(-not(Test-Path -LiteralPath $resolved -PathType Leaf)){throw "找不到 deployment settings：$resolved"}
  try{$settings=Get-Content -Raw -Encoding UTF8 -LiteralPath $resolved|ConvertFrom-Json}catch{throw "deployment settings JSON 無法解析：$resolved"}
  if([int]$settings.schemaVersion-ne1-or[string]::IsNullOrWhiteSpace([string]$settings.environmentName)){throw 'deployment settings schemaVersion/environmentName 不合法。'}
  $hostAddress=$null;$gateway=$null
  if(-not[Net.IPAddress]::TryParse([string]$settings.hostAddress,[ref]$hostAddress)-or$hostAddress.AddressFamily-ne[Net.Sockets.AddressFamily]::InterNetwork-or-not(Get-DeploymentPrivateMinimumPrefix $hostAddress)){throw 'hostAddress 必須是 private IPv4。'}
  if(-not[Net.IPAddress]::TryParse([string]$settings.defaultGateway,[ref]$gateway)-or$gateway.AddressFamily-ne[Net.Sockets.AddressFamily]::InterNetwork-or-not(Get-DeploymentPrivateMinimumPrefix $gateway)){throw 'defaultGateway 必須是 private IPv4。'}
  if([string]$settings.subnetCidr-notmatch'^(.+)/(\d{1,2})$'){throw 'subnetCidr 必須是 IPv4 CIDR。'}
  $subnet=$null;$prefix=[int]$Matches[2]
  if(-not[Net.IPAddress]::TryParse($Matches[1],[ref]$subnet)-or$subnet.AddressFamily-ne[Net.Sockets.AddressFamily]::InterNetwork-or$prefix-lt1-or$prefix-gt30){throw 'subnetCidr 必須是可配置 host/gateway 的 IPv4 CIDR（prefix 1..30）。'}
  $minimum=Get-DeploymentPrivateMinimumPrefix $subnet
  if(-not$minimum-or$prefix-lt$minimum){throw 'subnetCidr 必須完整位於 RFC1918 private range。'}
  $mask=[uint64]([Math]::Pow(2,32)-[Math]::Pow(2,32-$prefix));$network=(Convert-DeploymentIPv4ToNumber $subnet)-band$mask
  if((Convert-DeploymentIPv4ToNumber $subnet)-ne$network){throw 'subnetCidr 必須使用 network address。'}
  if(((Convert-DeploymentIPv4ToNumber $hostAddress)-band$mask)-ne$network-or((Convert-DeploymentIPv4ToNumber $gateway)-band$mask)-ne$network){throw 'hostAddress 與 defaultGateway 必須位於 subnetCidr。'}
  $broadcast=$network+[uint64]([Math]::Pow(2,32-$prefix)-1);$hostNumber=Convert-DeploymentIPv4ToNumber $hostAddress;$gatewayNumber=Convert-DeploymentIPv4ToNumber $gateway
  if($hostNumber-in@($network,$broadcast)-or$gatewayNumber-in@($network,$broadcast)){throw 'hostAddress/defaultGateway 不可使用 network 或 broadcast address。'}
  $allowed=@($settings.allowedClientRanges|ForEach-Object{([string]$_).Trim()}|Where-Object{$_})
  if(-not$allowed.Count){throw 'allowedClientRanges 不可為空。'}
  return [pscustomobject]@{Path=[IO.Path]::GetFullPath($resolved);EnvironmentName=[string]$settings.environmentName;HostAddress=$hostAddress.IPAddressToString;SubnetCidr=[string]$settings.subnetCidr;PrefixLength=$prefix;DefaultGateway=$gateway.IPAddressToString;AllowedClientRanges=$allowed}
}

$deploymentSettings=Read-DeploymentSettings
$DeploymentSettingsPath=$deploymentSettings.Path
$DeploymentEnvironmentName=$deploymentSettings.EnvironmentName
$ProductionCanonicalHost=$deploymentSettings.HostAddress
$ProductionPrefixLength=$deploymentSettings.PrefixLength
$ProductionSubnet=$deploymentSettings.SubnetCidr
$ProductionGateway=$deploymentSettings.DefaultGateway
$ProductionAllowedRemoteAddresses=@($deploymentSettings.AllowedClientRanges)

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
  foreach ($name in @('currentPath','logPath','runPath','backupPath')) {
    if (-not (Test-PathWithin ([string]$Candidate.$name) $installRoot)) { throw "$name 必須位於 installPath 之內。" }
  }
}

$InstallPath = Resolve-InputPath $InstallPath
$configWasProvided = -not [string]::IsNullOrWhiteSpace($ConfigPath)
if (-not $configWasProvided) {
  $installedConfig = Join-Path $InstallPath 'config\wdwelt.json'
  if (Test-Path -LiteralPath $installedConfig) { $ConfigPath = $installedConfig }
  elseif ($Command -eq 'install') { $ConfigPath = $installedConfig }
  else { $ConfigPath = Join-Path $SourceRoot 'config\development.json' }
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
  if ([string]::IsNullOrWhiteSpace([string]$config.backupPath)) { $config | Add-Member -NotePropertyName backupPath -NotePropertyValue (Join-Path $config.installPath 'backups') -Force }
  else { $config.backupPath = Resolve-ConfiguredPath ([string]$config.backupPath) }
  if ([string]::IsNullOrWhiteSpace([string]$config.mysqlServiceName)) { $config | Add-Member -NotePropertyName mysqlServiceName -NotePropertyValue 'MySQL80' -Force }
  $remoteProperty = $config.PSObject.Properties['allowedRemoteAddresses']
  if (-not $remoteProperty -or -not @($remoteProperty.Value).Count) {
    $defaultRemote = if ([string]$config.canonicalHost -eq $ProductionCanonicalHost) { @($ProductionAllowedRemoteAddresses) } else { @('LocalSubnet') }
    $config | Add-Member -NotePropertyName allowedRemoteAddresses -NotePropertyValue $defaultRemote -Force
  } else { $config | Add-Member -NotePropertyName allowedRemoteAddresses -NotePropertyValue @($remoteProperty.Value) -Force }
  if ([string]$config.networkPolicy -in @('school-fixed-v1','deployment-settings-v1') -and $Command -ne 'install') {
    if ([string]$config.canonicalHost -ne $ProductionCanonicalHost -or [int]$config.networkPrefixLength -ne $ProductionPrefixLength -or [string]$config.networkGateway -ne $ProductionGateway) {
      throw 'Installed network policy 與 config/deployment.json 不一致；請重新執行 install 更新環境設定。'
    }
    if ([string]$config.bindAddress -ne [string]$config.canonicalHost) { throw 'Production Node 必須只監聽 canonicalHost；請重新執行 install 更新設定。' }
  }
  foreach ($name in @('databaseConfigPath','adminDatabaseConfigPath')) {
    if ($config.$name) { $config.$name = Resolve-ConfiguredPath ([string]$config.$name) }
  }
  if ($config.nodePath) { $config.nodePath = Resolve-ConfiguredPath ([string]$config.nodePath) }
  Assert-SafeInstallLayout $config
  return $config
}

$Config = if ($Command -eq 'install' -and -not (Test-Path -LiteralPath $ConfigPath)) {
  [pscustomobject]@{
    port=8080; bindAddress='0.0.0.0'; canonicalHost=''; canonicalUrl=''; installPath=$InstallPath
    currentPath=(Join-Path $InstallPath 'current'); logPath=(Join-Path $InstallPath 'logs')
    runPath=(Join-Path $InstallPath 'run'); backupPath=(Join-Path $InstallPath 'backups'); healthIntervalSeconds=60; healthTimeoutSeconds=5
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
  foreach ($path in @($Config.logPath, $Config.runPath, $Config.backupPath)) { [IO.Directory]::CreateDirectory($path) | Out-Null }
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
      $ipConfig = Get-NetIPConfiguration -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
      [pscustomobject]@{
        Address=$_.IPAddress; PrefixLength=[int]$_.PrefixLength; InterfaceIndex=$_.InterfaceIndex; Interface=$_.InterfaceAlias
        Description=$adapter.InterfaceDescription; Gateway=@($ipConfig.IPv4DefaultGateway.NextHop)
        Virtual=($adapter.InterfaceDescription -match 'virtual|vpn|hyper-v|vmware|tap|tunnel')
      }
    })
  if ($native.Count) { return $native }
  @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object OperationalStatus -eq 'Up' | ForEach-Object {
      $interface = $_
      $_.GetIPProperties().UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.IPAddressToString -ne '127.0.0.1' } | ForEach-Object {
        [pscustomobject]@{
          Address=$_.Address.ToString(); PrefixLength=[int]$_.PrefixLength; InterfaceIndex=$interface.Id; Interface=$interface.Name
          Description=$interface.Description; Gateway=@($interface.GetIPProperties().GatewayAddresses | ForEach-Object { $_.Address.ToString() })
          Virtual=($interface.Description -match 'virtual|vpn|hyper-v|vmware|tap|tunnel')
        }
      }
    })
}

function Get-PrivateIPv4Class([Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  if ($bytes[0] -eq 10) { return [pscustomobject]@{Name='10/8';MinimumPrefix=8} }
  if ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) { return [pscustomobject]@{Name='172.16/12';MinimumPrefix=12} }
  if ($bytes[0] -eq 192 -and $bytes[1] -eq 168) { return [pscustomobject]@{Name='192.168/16';MinimumPrefix=16} }
  return $null
}

function Convert-IPv4ToNumber([Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  return ([uint64]$bytes[0] -shl 24) -bor ([uint64]$bytes[1] -shl 16) -bor ([uint64]$bytes[2] -shl 8) -bor [uint64]$bytes[3]
}

function Assert-AllowedRemoteAddresses([string[]]$Addresses, [switch]$AllowLocalSubnet) {
  $values = @($Addresses | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if (-not $values.Count) { throw 'Firewall allowed remote addresses 不可為空。' }
  foreach ($value in $values) {
    if ($value -eq 'LocalSubnet') {
      if (-not $AllowLocalSubnet) { throw 'Production firewall 不接受動態 LocalSubnet；必須使用 IT 明確提供的 address/CIDR。' }
      continue
    }
    if ($value -in @('*','Any','Internet','0.0.0.0/0')) { throw "Firewall scope 不得對外開放：$value" }
    if ($value -match '^(.+)/(\d{1,2})$') {
      $address = $null
      if (-not [Net.IPAddress]::TryParse($Matches[1], [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [int]$Matches[2] -lt 1 -or [int]$Matches[2] -gt 32) {
        throw "Firewall IPv4 CIDR 不合法：$value"
      }
      $privateClass = Get-PrivateIPv4Class $address
      if (-not $privateClass -or [int]$Matches[2] -lt [int]$privateClass.MinimumPrefix) { throw "Firewall remote CIDR 必須完整位於 RFC1918 private range：$value" }
      $prefix=[int]$Matches[2];$mask=[uint64]([Math]::Pow(2,32)-[Math]::Pow(2,32-$prefix))
      if(((Convert-IPv4ToNumber $address)-band$mask)-ne(Convert-IPv4ToNumber $address)){throw "Firewall remote CIDR 必須使用 network address：$value"}
      continue
    }
    if ($value -match '^([^-]+)-([^-]+)$') {
      $first = $null; $last = $null
      if (-not [Net.IPAddress]::TryParse($Matches[1], [ref]$first) -or -not [Net.IPAddress]::TryParse($Matches[2], [ref]$last) -or
          $first.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $last.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "Firewall IPv4 range 不合法：$value"
      }
      $firstClass = Get-PrivateIPv4Class $first; $lastClass = Get-PrivateIPv4Class $last
      if (-not $firstClass -or -not $lastClass -or $firstClass.Name -ne $lastClass.Name -or (Convert-IPv4ToNumber $first) -gt (Convert-IPv4ToNumber $last)) {
        throw "Firewall remote range 必須完整位於同一 RFC1918 private range 且由小到大：$value"
      }
      continue
    }
    $single = $null
    if (-not [Net.IPAddress]::TryParse($value, [ref]$single) -or $single.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
      throw "Firewall remote address 不合法：$value"
    }
    if (-not (Get-PrivateIPv4Class $single)) { throw "Firewall remote address 必須是 RFC1918 private IPv4：$value" }
  }
  return $values
}

function Get-ProductionNetworkState {
  $candidate = @(Get-LanCandidates | Where-Object Address -EQ $ProductionCanonicalHost | Select-Object -First 1)
  if (-not $candidate.Count) { return [pscustomobject]@{Ready=$false;Reason="$ProductionCanonicalHost is not assigned"} }
  $item = $candidate[0]
  if ([int]$item.PrefixLength -ne $ProductionPrefixLength) { return [pscustomobject]@{Ready=$false;Reason="prefix is /$($item.PrefixLength), expected /$ProductionPrefixLength";Candidate=$item} }
  if ($ProductionGateway -notin @($item.Gateway)) { return [pscustomobject]@{Ready=$false;Reason="gateway is $(@($item.Gateway) -join ', '), expected $ProductionGateway";Candidate=$item} }
  return [pscustomobject]@{Ready=$true;Reason='ok';Candidate=$item}
}

function Assert-ProductionNetwork {
  $state = Get-ProductionNetworkState
  if (-not $state.Ready) { throw "IT 固定網路未就緒：$($state.Reason)。WDWELT 不會自行修改 Windows NIC。" }
  return $state
}

function Get-PortOwner {
  $connection = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $listenAddress = if($connection){[string]$connection.LocalAddress}else{$null}
  $ownerPid = if ($connection) { [int]$connection.OwningProcess } else {
    $line = netstat -ano -p TCP | Select-String -Pattern '^\s*TCP\s+(\S+):8080\s+\S+\s+LISTENING\s+(\d+)\s*$' | Select-Object -First 1
    if ($line -and $line.Matches.Count) { $listenAddress=$line.Matches[0].Groups[1].Value;[int]$line.Matches[0].Groups[2].Value } else { 0 }
  }
  if (-not $ownerPid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  $basic = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  [pscustomobject]@{ PID=$ownerPid; Address=if($listenAddress){$listenAddress}else{'無法確認'}; Name=if($process){$process.Name}elseif($basic){$basic.ProcessName}else{'無法確認'}; CommandLine=if($process){$process.CommandLine}else{$null} }
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
  if (-not (Test-Path -LiteralPath $serverPath)) { $serverPath = [IO.Path]::GetFullPath((Join-Path $SourceRoot 'server\app\server.mjs')) }
  $processName = if($process){$process.Name}else{$basic.ProcessName}
  if ($processName -notmatch '^node(\.exe)?$') { return $null }
  $commandVerified = [bool]$process.CommandLine
  if ($commandVerified -and (($process.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) -or ($process.CommandLine.IndexOf($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -lt 0))) { return $null }
  $owner = Get-PortOwner
  if ($owner -and [int]$owner.PID -ne [int]$record.pid) { return $null }
  if (-not $commandVerified) {
    $health = Invoke-LiveHealth
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

function Invoke-HealthEndpoint([string]$Endpoint,[int]$TimeoutSeconds = [int]$Config.healthTimeoutSeconds) {
  try {
    $healthAddress = if ([string]$Config.bindAddress -in @('0.0.0.0','::','*','')) { '127.0.0.1' } else { [string]$Config.bindAddress }
    $result = Invoke-RestMethod -Method Get -Uri "http://${healthAddress}:8080$Endpoint" -TimeoutSec $TimeoutSeconds
    if (-not $result.version -or -not $result.build) { throw 'health response 缺少必要欄位' }
    return $result
  } catch { return $null }
}
function Invoke-LiveHealth([int]$TimeoutSeconds = [int]$Config.healthTimeoutSeconds){Invoke-HealthEndpoint '/health/live' $TimeoutSeconds}
function Invoke-ReadyHealth([int]$TimeoutSeconds = [int]$Config.healthTimeoutSeconds){Invoke-HealthEndpoint '/health/ready' $TimeoutSeconds}
function Invoke-Health([int]$TimeoutSeconds = [int]$Config.healthTimeoutSeconds){Invoke-HealthEndpoint '/health' $TimeoutSeconds}
function Test-DatabaseConfigured {[bool]($Config.databaseConfigPath-and(Test-Path -LiteralPath $Config.databaseConfigPath -PathType Leaf))}

function Get-MySqlService {
  if ([string]::IsNullOrWhiteSpace([string]$Config.mysqlServiceName)) { return $null }
  return Get-Service -Name ([string]$Config.mysqlServiceName) -ErrorAction SilentlyContinue
}

function Start-ConfiguredMySql {
  $service = Get-MySqlService
  if (-not $service) { Write-OperationLog warning db_service_missing 'Configured MySQL service was not found.'; return $false }
  if ($service.Status -eq 'Running') { return $true }
  try {
    Start-Service -Name $service.Name -ErrorAction Stop
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(20))
    Write-OperationLog info db_service_start 'Configured MySQL service was started.'
    return $true
  } catch {
    Write-OperationLog warning db_service_start_failure 'Configured MySQL service could not be started.'
    return $false
  }
}

function Invoke-DatabaseTool([string]$ScriptName, [string[]]$Arguments, [string]$Root = $Config.installPath) {
  $node = if ($Config.nodePath) { [string]$Config.nodePath } else { (Get-Command node -ErrorAction Stop).Source }
  $script = Join-Path $Root "db\operations\$ScriptName"
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "找不到 database tool：$script" }
  & $node $script @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Database tool failed：$ScriptName" }
}

function Invoke-DatabaseBackup([string]$Label = 'manual', [string]$ToolRoot = $Config.installPath) {
  if (-not $Config.adminDatabaseConfigPath -or -not (Test-Path -LiteralPath $Config.adminDatabaseConfigPath -PathType Leaf)) { throw '找不到 administrative database config；未執行 backup。' }
  Ensure-Directories
  Write-OperationLog info backup_start "Backup label $Label started."
  try {
    Invoke-DatabaseTool 'backup.mjs' @('--config',[string]$Config.adminDatabaseConfigPath,'--output',[string]$Config.backupPath,'--label',$Label) $ToolRoot
    Write-OperationLog info backup_success "Backup label $Label completed."
  } catch {
    Write-OperationLog error backup_failure 'Database backup failed.'
    throw
  }
}

function Invoke-DatabaseMigration([string]$ToolRoot = $Config.installPath) {
  if (-not $Config.adminDatabaseConfigPath -or -not (Test-Path -LiteralPath $Config.adminDatabaseConfigPath -PathType Leaf)) { throw '找不到 administrative database config；未執行 migration。' }
  Write-OperationLog info migration_start 'Database migration started.'
  try {
    Invoke-DatabaseTool 'migrate.mjs' @('--config',[string]$Config.adminDatabaseConfigPath,'--migrations',(Join-Path $ToolRoot 'db\migrations')) $ToolRoot
    Write-OperationLog info migration_success 'Database migration completed.'
  } catch {
    Write-OperationLog error migration_failure 'Database migration failed.'
    throw
  }
}

function Invoke-DatabaseRestore([string]$Source) {
  if([string]::IsNullOrWhiteSpace($Source)){throw 'restore 需要 -BackupFile。'}
  $script=Join-Path $Config.installPath 'tools\database\restore.ps1'
  if(-not(Test-Path -LiteralPath $script -PathType Leaf)){$script=Join-Path $SourceRoot 'install\windows\restore.ps1'}
  & $script -BackupFile (Resolve-InputPath $Source) -ConfigPath $ConfigPath -AdminConfigPath $Config.adminDatabaseConfigPath
  if($LASTEXITCODE-ne0){throw 'Database restore failed.'}
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
    $live = Invoke-LiveHealth
    if ($live) { Write-Host "WDWELT 已在執行：$($live.version) build $($live.build)"; return }
    throw '找到已驗證的 WDWELT process，但 liveness 失敗；請執行 recover。'
  }
  $owner = Get-PortOwner
  if ($owner) { throw "Port 8080 已被 PID $($owner.PID) $($owner.Name) 占用；未停止該程序。" }
  $node = if ($Config.nodePath) { [string]$Config.nodePath } else { (Get-Command node -ErrorAction Stop).Source }
  $server = Join-Path $Config.installPath 'tools\host\server.mjs'
  if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $SourceRoot 'server\app\server.mjs' }
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
    $live = Invoke-LiveHealth 2
    if ($live -and $live.version -eq $expectedRelease.version -and $live.build -eq $expectedRelease.build) {
      Write-OperationLog info start "Liveness verified for PID $($process.Id)."
      $ready = Invoke-ReadyHealth 2
      if (-not $ready -and (Test-DatabaseConfigured)) { Write-Warning 'Node 已啟動，但 MySQL 尚未 ready；API 暫時回傳 503，host 會繼續重連。' }
      Write-Host "啟動完成：$($Config.canonicalUrl) ($($live.version) build $($live.build))"
      return
    }
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  throw 'Host 已啟動但 /health/live 在期限內未成功。'
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
    $live = Invoke-LiveHealth
    if ($live) {
      if (-not (Invoke-ReadyHealth) -and (Test-DatabaseConfigured)) { Start-ConfiguredMySql | Out-Null; Write-Host 'Node 正常；資料庫尚未 ready，因此沒有重啟 Node。' }
      else { Write-Host 'WDWELT 已健康，不需要 recovery。' }
      return
    }
    $verified = Get-VerifiedHost
    if ($verified) { Stop-Wdwelt -Maintenance }
    elseif (Get-PortOwner) { throw 'Port 8080 由未知程序占用；recovery 未停止它。' }
    Read-Release | Out-Null
    Start-Wdwelt
    if (-not (Invoke-LiveHealth)) { throw 'Recovery start 後 liveness 仍失敗。' }
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
    $live = Invoke-LiveHealth
    if ($live) {
      Remove-Item -LiteralPath $FailureFile -Force -ErrorAction SilentlyContinue
      if (-not (Invoke-ReadyHealth) -and (Test-DatabaseConfigured)) {
        Start-ConfiguredMySql | Out-Null
        Write-OperationLog warning db_not_ready 'Node is live; watchdog did not restart it while database was unavailable.'
      }
      return
    }
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
    if(Invoke-LiveHealth){if(-not(Invoke-ReadyHealth)-and(Test-DatabaseConfigured)){Start-ConfiguredMySql|Out-Null};return}
    try { Recover-Wdwelt; if(Invoke-LiveHealth){return} } catch { Write-OperationLog warning boot "Boot attempt $attempt failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds ([Math]::Min(10*$attempt,30))
  }
  throw 'Boot retries exhausted; WDWELT remains unhealthy.'
}

function Show-Status {
  $verified = Get-VerifiedHost
  $live = Invoke-LiveHealth
  $ready = Invoke-ReadyHealth
  $release = try { Read-Release } catch { $null }
  $candidates = Get-LanCandidates
  $owner = Get-PortOwner
  $lock = Get-MaintenanceLock
  $tasks = @('WDWELT Boot','WDWELT 0700','WDWELT Watchdog','WDWELT DB Backup 1800') | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
  $mysql = Get-MySqlService
  $lastBackup = Get-ChildItem -LiteralPath $Config.backupPath -Filter 'g2-*.sql' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $previousRelease = try { $p=Read-Release (Join-Path $Config.installPath 'previous'); "$($p.version) build $($p.build)" } catch { 'none' }
  $recentError = try { (Get-Content -Tail 100 -LiteralPath (Join-Path $Config.logPath 'operations.jsonl') | ConvertFrom-Json | Where-Object level -eq 'error' | Select-Object -Last 1).message } catch { 'none' }
  [ordered]@{
    Running=[bool]$verified; Liveness=if($live){'ok'}elseif($verified){'failed'}else{'stopped'}; Readiness=if($ready){'ok'}elseif($live){'database unavailable'}else{'unavailable'}; PID=if($verified){$verified.Record.pid}else{'無法確認'}
    ActualListeningAddress=if($owner){$owner.Address}else{'無法確認'}; CanonicalLanUrl=$Config.canonicalUrl
    DetectedLanIPv4Candidates=if($candidates){(($candidates|ForEach-Object Address) -join ', ')}else{'無法確認'}; Port=8080
    Version=if($live){$live.version}elseif($release){$release.version}else{'無法確認'}; Build=if($live){$live.build}elseif($release){$release.build}else{'無法確認'}
    UptimeSeconds=if($live){$live.uptimeSeconds}else{'無法確認'}; LastHealthCheck=(Get-Date).ToString('s')
    MySqlService=if($mysql){"$($mysql.Name): $($mysql.Status)"}else{'not found'}
    DatabaseConfigured=(Test-DatabaseConfigured); DatabaseConnection=if($ready){$ready.database}else{'unavailable'}
    CurrentMigration=if($ready){$ready.migration}else{'unavailable'}; LastDatabaseCheck=if($ready-and$ready.databaseLastCheck){$ready.databaseLastCheck}else{'unavailable'}
    LastDatabaseBackup=if($lastBackup){"$($lastBackup.Name) ($($lastBackup.LastWriteTime.ToString('s')))"}else{'none'}
    ManualStop=(Test-Path -LiteralPath $ManualStopFile); MaintenanceLock=if($lock){"$($lock.owner) until $($lock.expiresAt)"}else{'none'}
    CurrentRelease=if($release){"$($release.version) build $($release.build)"}else{'無法確認'}
    PreviousRelease=$previousRelease
    BootTask=if($tasks | Where-Object TaskName -eq 'WDWELT Boot'){'installed'}else{'not installed'}
    Daily0700Task=if($tasks | Where-Object TaskName -eq 'WDWELT 0700'){'installed'}else{'not installed'}
    WatchdogTask=if($tasks | Where-Object TaskName -eq 'WDWELT Watchdog'){'installed'}else{'not installed'}
    DatabaseBackupTask=if($tasks | Where-Object TaskName -eq 'WDWELT DB Backup 1800'){'installed'}else{'not installed'}
    RecentError=$recentError
  } | Format-List
}

function Test-Network {
  $candidates = Get-LanCandidates; $owner = Get-PortOwner; $live = Invoke-LiveHealth; $ready = Invoke-ReadyHealth
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
  $firewall = @(Get-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -ErrorAction SilentlyContinue)
  $addressFilters = @($firewall | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue)
  $portFilters = @($firewall | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
  $verifiedHost = Get-VerifiedHost
  $candidateAddresses=@($candidates|ForEach-Object Address)
  $canonicalIsLocal = $Config.canonicalHost -in @('127.0.0.1','localhost') -or $Config.canonicalHost -in $candidateAddresses
  $listenerMatches = $owner -and [string]$owner.Address -eq [string]$Config.bindAddress
  $expectedRemote = @(Assert-AllowedRemoteAddresses @($Config.allowedRemoteAddresses) -AllowLocalSubnet:([string]$Config.canonicalHost -ne $ProductionCanonicalHost))
  $actualRemote = @($addressFilters | ForEach-Object RemoteAddress | ForEach-Object { $_ } | Sort-Object -Unique)
  $actualLocal = @($addressFilters | ForEach-Object LocalAddress | ForEach-Object { $_ } | Sort-Object -Unique)
  $remoteMatches = $actualRemote.Count -eq $expectedRemote.Count -and -not @(Compare-Object ($expectedRemote | Sort-Object -Unique) $actualRemote).Count
  $localMatches = $actualLocal.Count -eq 1 -and $actualLocal[0] -eq [string]$Config.canonicalHost
  $portMatches = $portFilters.Count -eq 1 -and [string]$portFilters[0].Protocol -in @('TCP','6') -and [string]$portFilters[0].LocalPort -eq '8080'
  $firewallEnabled = $firewall.Count -eq 1 -and [string]$firewall[0].Enabled -eq 'True'
  $firewallProfiles=if($firewall.Count){[string]$firewall[0].Profile}else{''}
  $profileMatches=$firewallProfiles -notmatch 'Any' -and $firewallProfiles -match 'Domain' -and $firewallProfiles -match 'Private'
  $ruleMatches = $firewall.Count -eq 1 -and [string]$firewall[0].Direction -eq 'Inbound' -and [string]$firewall[0].Action -eq 'Allow' -and [string]$firewall[0].EdgeTraversalPolicy -eq 'Block' -and $profileMatches
  $firewallCorrect = $firewallEnabled -and $ruleMatches -and $remoteMatches -and $localMatches -and $portMatches
  Write-Host "LAN IPv4 candidates: $(if($candidates){$candidateAddresses -join ', '}else{'無法確認'})"
  if ($candidates.Count -gt 1 -or ($candidates | Where-Object Virtual)) { Write-Warning '偵測到多網卡、VPN 或虛擬網卡；canonical host 必須人工確認。' }
  if (-not $canonicalIsLocal) { Write-Warning "canonical host $($Config.canonicalHost) 不在目前 LAN IPv4 candidates。" }
  Write-Host "Port 8080: $(if($owner){"listening on $($owner.Address), PID $($owner.PID) $($owner.Name)"}else{'not listening'})"
  Write-Host "Listener address matches config: $([bool]$listenerMatches)"
  Write-Host "Port owner verified as WDWELT: $([bool]$verifiedHost)"
  Write-Host "Configured-address liveness: $(if($live){'ok'}else{'failed'})"
  Write-Host "Database readiness: $(if($ready){'ok'}else{'unavailable'})"
  Write-Host "Windows profiles: $(if($profiles){($profiles.NetworkCategory -join ', ')}else{'無法確認'})"
  Write-Host "Firewall rule: $(if($firewall.Count){$firewall[0].Enabled}else{'not installed'})"
  Write-Host "Firewall profiles: $(if($firewallProfiles){$firewallProfiles}else{'無法確認'})"
  Write-Host "Firewall local address: $(if($actualLocal.Count){$actualLocal -join ', '}else{'無法確認'})"
  Write-Host "Firewall allowed remote addresses: $(if($actualRemote.Count){$actualRemote -join ', '}else{'無法確認'})"
  Write-Host "Firewall scope verified: $firewallCorrect"
  if ($Config.canonicalHost -notmatch '^\d+\.\d+\.\d+\.\d+$') { try { Write-Host "Hostname resolution: $([Net.Dns]::GetHostAddresses($Config.canonicalHost) -join ', ')" } catch { Write-Warning 'Hostname 無法解析。' } }
  Write-Host "Canonical URL: $($Config.canonicalUrl)"
  if ($live -and $verifiedHost -and $listenerMatches) { Write-Host '本機 WDWELT Node 正常，且監聽位址符合設定。' }
  if ([string]$Config.networkPolicy -in @('school-fixed-v1','deployment-settings-v1')) {
    Write-Host "目前允許範圍：$($expectedRemote -join ', ')；其他校內 VLAN 需由 IT 加入 deployment settings。"
    if(-not $canonicalIsLocal -or -not $listenerMatches -or -not $verifiedHost -or -not $live -or -not $ready -or -not $firewallCorrect){
      throw 'Production network verification failed：canonical IP、exact listener、WDWELT process、live/ready 與 firewall scope 必須全部正確。'
    }
  }
  if ($live -and $ready -and $verifiedHost -and $canonicalIsLocal -and $firewallCorrect) { Write-Host '本機 LAN 與資料庫設定看起來可用。' }
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
    @{Name='WDWELT Watchdog'; Trigger='MINUTE'; Modifier=[string][Math]::Max(1,[Math]::Ceiling([int]$Config.healthIntervalSeconds / 60)); Cmd="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$taskScript`" watchdog -ConfigPath `"$ConfigPath`""},
    @{Name='WDWELT DB Backup 1800'; Trigger='DAILY'; Modifier=$null; Cmd="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$taskScript`" backup -ConfigPath `"$ConfigPath`""}
  )
  foreach($spec in $specs) {
    $args = @('/Create','/TN',$spec.Name,'/TR',$spec.Cmd,'/SC',$spec.Trigger,'/F','/RL','HIGHEST','/RU','SYSTEM')
    if($spec.Name -eq 'WDWELT 0700'){ $args += @('/ST','07:00') }
    if($spec.Name -eq 'WDWELT DB Backup 1800'){ $args += @('/ST','18:00') }
    if($spec.Modifier){ $args += @('/MO',$spec.Modifier) }
    if($DryRun){ Write-Host "[DRY-RUN] schtasks.exe $($args -join ' '); MultipleInstances=IgnoreNew; WakeToRun=$($spec.Name -eq 'WDWELT 0700')" } else {
      & schtasks.exe @args; if($LASTEXITCODE -ne 0){throw "Task install failed: $($spec.Name)"}
      $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -WakeToRun:($spec.Name -eq 'WDWELT 0700') -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
      Set-ScheduledTask -TaskName $spec.Name -Settings $settings | Out-Null
    }
  }
}

function Install-Firewall {
  $remoteAddresses = if (@($AllowedRemoteAddress).Count) { @($AllowedRemoteAddress) } else { @($Config.allowedRemoteAddresses) }
  $remoteAddresses = @(Assert-AllowedRemoteAddresses $remoteAddresses -AllowLocalSubnet:([string]$Config.canonicalHost -ne $ProductionCanonicalHost))
  if (-not $DryRun -and [string]$Config.canonicalHost -eq $ProductionCanonicalHost) { Assert-ProductionNetwork | Out-Null }
  $canonicalIp = Get-NetIPAddress -AddressFamily IPv4 -IPAddress ([string]$Config.canonicalHost) -ErrorAction SilentlyContinue | Select-Object -First 1
  $profiles = if ($canonicalIp) { Get-NetConnectionProfile -InterfaceIndex $canonicalIp.InterfaceIndex -ErrorAction SilentlyContinue } else { @() }
  if (-not $DryRun -and -not $canonicalIp) { throw '無法確認 canonical host 所在的 Windows network interface；未建立 Firewall rule。' }
  if (-not $DryRun -and -not @($profiles).Count) { throw '無法確認 canonical host 的 Windows network profile；未建立 Firewall rule。' }
  if (($profiles.NetworkCategory -contains 'Public') -and -not $AllowPublicProfile) { throw '目前包含 Public network profile；需明確指定 -AllowPublicProfile 才會建立規則。' }
  if ($DryRun) { Write-Host "[DRY-RUN] Ensure firewall rule WDWELT LAN TCP 8080; local=$($Config.canonicalHost); remote=$($remoteAddresses -join ','); TCP 8080; Private/Domain$(if($AllowPublicProfile){'/Public'})."; return }
  Get-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $firewallProfiles = if($AllowPublicProfile){'Private','Domain','Public'}else{'Private','Domain'}
  $createdRule = New-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -LocalAddress ([string]$Config.canonicalHost) -RemoteAddress $remoteAddresses -Profile $firewallProfiles -EdgeTraversalPolicy Block -Action Allow
  $createdAddress = @($createdRule | Get-NetFirewallAddressFilter); $createdPort = @($createdRule | Get-NetFirewallPortFilter)
  $actualRemote = @($createdAddress | ForEach-Object RemoteAddress | Sort-Object -Unique)
  $createdProfiles=[string]$createdRule.Profile
  $createdProfilesMatch=$createdProfiles -notmatch 'Any' -and $createdProfiles -match 'Domain' -and $createdProfiles -match 'Private' -and ([bool]($createdProfiles -match 'Public') -eq [bool]$AllowPublicProfile)
  $scopeMatches = $createdAddress.Count -eq 1 -and [string]$createdAddress[0].LocalAddress -eq [string]$Config.canonicalHost -and
    $actualRemote.Count -eq $remoteAddresses.Count -and -not @(Compare-Object ($remoteAddresses | Sort-Object -Unique) $actualRemote).Count -and
    $createdPort.Count -eq 1 -and [string]$createdPort[0].Protocol -in @('TCP','6') -and [string]$createdPort[0].LocalPort -eq '8080' -and $createdProfilesMatch
  if (-not $scopeMatches) { $createdRule | Remove-NetFirewallRule; throw 'Firewall rule 建立後驗證失敗；已移除規則。' }
}

function Invoke-Package {
  [void](Assert-AllowedRemoteAddresses $ProductionAllowedRemoteAddresses)
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'dist\build-metadata.json'))) { throw '請先執行 npm run build。' }
  $output = if($PackagePath){Resolve-InputPath $PackagePath}else{Join-Path $SourceRoot 'artifacts\wdwelt-package'}
  $output = [IO.Path]::GetFullPath($output)
  $outputRoot = [IO.Path]::GetPathRoot($output).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($output.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($outputRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $output.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($SourceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒絕將 package 輸出到不安全位置：$output"
  }
  if(Test-Path $output){
    $existingManifest=Join-Path $output 'manifest.json'
    if(-not(Test-Path $existingManifest)){throw "拒絕覆寫非 WDWELT package directory：$output"}
    try{$existing=Get-Content -Raw -Encoding UTF8 $existingManifest|ConvertFrom-Json}catch{throw '既有 package manifest 無法驗證，拒絕覆寫。'}
    if([int]$existing.formatVersion -notin @(1,2)){throw '既有目錄不是可確認的 WDWELT package，拒絕覆寫。'}
    $unexpected = @(Get-ChildItem -LiteralPath $output -Force | Where-Object Name -notin @('production','host','tools','db','manifest.json'))
    if ($unexpected.Count) { throw "Package directory 含有不屬於 WDWELT package 的項目，拒絕覆寫：$($unexpected.Name -join ', ')" }
    Remove-Item -LiteralPath $output -Recurse -Force
  }
  [IO.Directory]::CreateDirectory((Join-Path $output 'production'))|Out-Null; [IO.Directory]::CreateDirectory((Join-Path $output 'host'))|Out-Null; [IO.Directory]::CreateDirectory((Join-Path $output 'tools\database'))|Out-Null; [IO.Directory]::CreateDirectory((Join-Path $output 'db'))|Out-Null
  Copy-Item (Join-Path $SourceRoot 'dist\*') (Join-Path $output 'production') -Recurse
  Copy-Item (Join-Path $SourceRoot 'server\app\*') (Join-Path $output 'host') -Recurse
  foreach($databaseDirectory in @('core','operations','migrations')){Copy-Item -LiteralPath (Join-Path $SourceRoot "db\$databaseDirectory") -Destination (Join-Path $output "db\$databaseDirectory") -Recurse}
  Copy-Item (Join-Path $SourceRoot 'install\windows\backup.ps1') (Join-Path $output 'tools\database\backup.ps1')
  Copy-Item (Join-Path $SourceRoot 'install\windows\restore.ps1') (Join-Path $output 'tools\database\restore.ps1')
  Copy-Item $PSCommandPath (Join-Path $output 'tools\wdwelt.ps1')
  Copy-Item -LiteralPath $DeploymentSettingsPath -Destination (Join-Path $output 'tools\deployment.json')
  $nodeForPackage=(Get-Command node -ErrorAction Stop).Source
  & $nodeForPackage (Join-Path $SourceRoot 'scripts\build\copy-production-dependencies.mjs') $SourceRoot (Join-Path $output 'host\node_modules')
  if($LASTEXITCODE-ne0){throw 'Production dependency packaging failed.'}
  $release=Read-Release (Join-Path $output 'production')
  $files=@(Get-ChildItem (Join-Path $output 'production'),(Join-Path $output 'host'),(Join-Path $output 'tools'),(Join-Path $output 'db') -File -Recurse | ForEach-Object { @{path=$_.FullName.Substring($output.Length+1).Replace('\','/');sha256=(Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()} })
  @{formatVersion=2;version=$release.version;build=$release.build;createdAt=(Get-Date).ToUniversalTime().ToString('o');productionDirectory='production';hostDirectory='host';toolsDirectory='tools';databaseDirectory='db';files=$files}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $output 'manifest.json')
  Write-Host "Package created: $output"
}

function Validate-Package([string]$Path) {
  $root=Resolve-InputPath $Path
  if(-not(Test-Path -LiteralPath $root -PathType Container)){throw "找不到 package directory：$root"}
  $manifestPath=Join-Path $root 'manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'Package 缺少 manifest.json。'}
  try { $manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath|ConvertFrom-Json } catch { throw 'Package manifest 無法解析。' }
  if ([int]$manifest.formatVersion -ne 2) { throw 'Package manifest formatVersion 不支援。' }
  if ($manifest.productionDirectory -ne 'production' -or $manifest.hostDirectory -ne 'host' -or $manifest.toolsDirectory -ne 'tools' -or $manifest.databaseDirectory -ne 'db') { throw 'Package directory layout 不合法。' }
  $productionRoot=Join-Path $root 'production';$hostRoot=Join-Path $root 'host';$toolsRoot=Join-Path $root 'tools';$databaseRoot=Join-Path $root 'db'
  $reparsePoints=@(Get-ChildItem -LiteralPath $productionRoot,$hostRoot,$toolsRoot,$databaseRoot -Force -Recurse -ErrorAction Stop|Where-Object{($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0})
  if($reparsePoints.Count){throw 'Package 不可包含 symlink／junction／reparse point。'}
  $release=Read-Release $productionRoot
  if($manifest.version -ne $release.version -or $manifest.build -ne $release.build){throw 'Package manifest 與 build metadata 不一致。'}
  foreach ($required in @((Join-Path $productionRoot 'index.html'),(Join-Path $productionRoot 'build-metadata.json'),(Join-Path $hostRoot 'server.mjs'),(Join-Path $hostRoot 'node_modules\mysql2\package.json'),(Join-Path $databaseRoot 'operations\migrate.mjs'),(Join-Path $databaseRoot 'operations\runtime-check.mjs'),(Join-Path $databaseRoot 'core\config.mjs'),(Join-Path $databaseRoot 'migrations\001_initial.sql'),(Join-Path $toolsRoot 'wdwelt.ps1'),(Join-Path $toolsRoot 'deployment.json'),(Join-Path $toolsRoot 'database\backup.ps1'),(Join-Path $toolsRoot 'database\restore.ps1'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Package 缺少必要檔案：$required" }
  }
  $manifestFiles=@($manifest.files)
  if (-not $manifestFiles.Count) { throw 'Package manifest files 不可為空。' }
  $declared=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($file in $manifestFiles){
    $relative=[string]$file.path
    if([string]::IsNullOrWhiteSpace($relative)-or[IO.Path]::IsPathRooted($relative)){throw 'Package manifest 含有不合法路徑。'}
    $target=[IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))))
    $inAllowedDirectory=(Test-PathWithin $target $productionRoot)-or(Test-PathWithin $target $hostRoot)-or(Test-PathWithin $target $toolsRoot)-or(Test-PathWithin $target $databaseRoot)
    if(-not(Test-PathWithin $target $root)-or-not $inAllowedDirectory){throw "Package manifest path 越界：$relative"}
    if(-not $declared.Add($target)){throw "Package manifest path 重複：$relative"}
    if(-not(Test-Path -LiteralPath $target -PathType Leaf)){throw "Package 缺少 $relative。"}
    if(([string]$file.sha256)-notmatch '^[0-9a-fA-F]{64}$'){throw "Package checksum 格式不合法：$relative"}
    $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
    if($hash-ne([string]$file.sha256).ToLowerInvariant()){throw "Package checksum 失敗：$relative"}
  }
  $actualFiles=@(Get-ChildItem -LiteralPath $productionRoot,$hostRoot,$toolsRoot,$databaseRoot -File -Recurse)
  if($actualFiles.Count-ne$declared.Count-or($actualFiles|Where-Object{-not $declared.Contains($_.FullName)})){throw 'Package 內含未列入 manifest 的檔案。'}
  [pscustomobject]@{Root=$root;Manifest=$manifest;Release=$release}
}

function Test-Administrator { $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

function Copy-ProtectedCredential([string]$Source,[string]$Destination) {
  $sourcePath=Resolve-InputPath $Source
  if(-not(Test-Path -LiteralPath $sourcePath -PathType Leaf)){throw "找不到 database credential file：$sourcePath"}
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))|Out-Null
  $temporary="$Destination.$PID.tmp"
  try{
    Copy-Item -LiteralPath $sourcePath -Destination $temporary -Force
    $operator=if($env:USERDOMAIN-and$env:USERNAME){"$env:USERDOMAIN\$env:USERNAME"}else{$env:USERNAME}
    $grants=@('*S-1-5-18:F','*S-1-5-32-544:F');if($operator){$grants+="${operator}:F"}
    & icacls.exe $temporary '/inheritance:r' '/grant:r' @grants | Out-Null
    if($LASTEXITCODE-ne0){throw 'Database credential ACL 設定失敗。'}
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
  }finally{Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}
}

function Copy-FileAtomically([string]$Source,[string]$Destination) {
  if(-not(Test-Path -LiteralPath $Source -PathType Leaf)){throw "找不到要安裝的檔案：$Source"}
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))|Out-Null
  $temporary="$Destination.$PID.tmp"
  try{Copy-Item -LiteralPath $Source -Destination $temporary -Force;Move-Item -LiteralPath $temporary -Destination $Destination -Force}
  finally{Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}
}

function Remove-LegacyInstalledCredentials {
  foreach($legacyName in @('database.json','migration.database.json')){
    $legacyPath=Join-Path $InstallPath "config\$legacyName"
    if(Test-Path -LiteralPath $legacyPath -PathType Leaf){Remove-Item -LiteralPath $legacyPath -Force}
  }
}

function Assert-MySqlPrerequisites([string]$ServiceName,[string]$NodeExecutable,[string]$AdminConfig,[string]$RuntimeConfig,[string]$DatabaseToolRoot) {
  $service=Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if(-not $service){throw "找不到既有 MySQL Windows service：$ServiceName。WDWELT 不會安裝 MySQL。"}
  if($service.Status-ne'Running'){Start-Service -Name $ServiceName;$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(20))}
  $preflightText=& $NodeExecutable (Join-Path $DatabaseToolRoot 'operations\preflight.mjs') --config $AdminConfig
  if($LASTEXITCODE-ne0){throw 'MySQL preflight failed.'}
  try{$preflight=($preflightText -join "`n")|ConvertFrom-Json}catch{throw 'MySQL preflight output 無法驗證。'}
  if([string]$preflight.database[0].value-ne'g2'){throw 'Administrative database config 必須連到既有 g2 database。'}
  $bind=[string]$preflight.bindAddress[0].Value
  if($bind-notin @('127.0.0.1','localhost','::1')){throw "MySQL bind_address 必須限制為 localhost，目前為 $bind。未開放 3306。"}
  $mysqlxRows=@($preflight.mysqlxBindAddress)
  if($mysqlxRows.Count -and [string]$mysqlxRows[0].Value -notin @('127.0.0.1','localhost','::1')){throw "MySQL mysqlx_bind_address 必須限制為 localhost，目前為 $([string]$mysqlxRows[0].Value)。未開放 X Protocol。"}
  $runtimeText=& $NodeExecutable (Join-Path $DatabaseToolRoot 'operations\runtime-check.mjs') --config $RuntimeConfig
  if($LASTEXITCODE-ne0){throw 'wdwelt_app runtime database check failed.'}
  try{$runtimeCheck=($runtimeText -join "`n")|ConvertFrom-Json}catch{throw 'Runtime database check output 無法驗證。'}
  if(-not$runtimeCheck.ready-or$runtimeCheck.database-ne'g2'){throw 'Runtime database config 未連到 g2。'}
}

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
    $chosen=if($CanonicalHost){$CanonicalHost}else{$ProductionCanonicalHost}
    if(-not $Config.installPath.Equals($InstallPath,[StringComparison]::OrdinalIgnoreCase)){throw '既有 config 的 installPath 與 -InstallPath 不一致。'}
    $chosenRemote=if(@($AllowedRemoteAddress).Count){@($AllowedRemoteAddress)}else{@($ProductionAllowedRemoteAddresses)}
  }else{
    $chosen=if($CanonicalHost){$CanonicalHost}else{$ProductionCanonicalHost}
    $chosenRemote=if(@($AllowedRemoteAddress).Count){@($AllowedRemoteAddress)}else{@($ProductionAllowedRemoteAddresses)}
  }
  if(-not $chosen.Equals($ProductionCanonicalHost,[StringComparison]::OrdinalIgnoreCase)){throw "Canonical host 必須符合 deployment settings 內的 $ProductionCanonicalHost；拒絕使用 $chosen。"}
  $chosenRemote=@(Assert-AllowedRemoteAddresses $chosenRemote)
  if(-not $DryRun -and -not(Test-Administrator)){throw '安裝需要 Administrator 權限。'}
  $windowsVersion=[Environment]::OSVersion.VersionString
  $nodeExecutable=if($NodePath){Resolve-InputPath $NodePath}elseif($existingInstall -and $Config.nodePath){[string]$Config.nodePath}else{(Get-Command node -ErrorAction SilentlyContinue).Source}
  if(-not $nodeExecutable -or -not(Test-Path -LiteralPath $nodeExecutable -PathType Leaf)){throw '找不到 Node runtime；請由使用者明確安裝或以 -NodePath 提供可執行 Node host 的 runtime。'}
  $runtimeCredentialSource=if($DatabaseConfigPath){Resolve-InputPath $DatabaseConfigPath}elseif($existingInstall-and$Config.databaseConfigPath-and(Test-Path -LiteralPath $Config.databaseConfigPath -PathType Leaf)){[string]$Config.databaseConfigPath}else{$null}
  $adminCredentialSource=if($AdminDatabaseConfigPath){Resolve-InputPath $AdminDatabaseConfigPath}elseif($existingInstall-and$Config.adminDatabaseConfigPath-and(Test-Path -LiteralPath $Config.adminDatabaseConfigPath -PathType Leaf)){[string]$Config.adminDatabaseConfigPath}else{$null}
  if(-not$runtimeCredentialSource-or-not$adminCredentialSource){throw 'install 需要既有 runtime 與 administrative database config；請指定 -DatabaseConfigPath 與 -AdminDatabaseConfigPath。'}
  if(-not(Test-Path -LiteralPath $runtimeCredentialSource -PathType Leaf)-or-not(Test-Path -LiteralPath $adminCredentialSource -PathType Leaf)){throw 'Runtime 或 administrative database config 路徑不存在。'}
  Write-Host "Windows: $windowsVersion; Node: $(& $nodeExecutable --version)"
  Write-Host "Install $($package.Release.version) build $($package.Release.build) to $InstallPath; canonical URL http://${chosen}:8080"
  Write-Host "Deployment environment: $DeploymentEnvironmentName; network=$ProductionCanonicalHost/$ProductionPrefixLength; gateway=$ProductionGateway; firewall remote=$($chosenRemote -join ',')"
  $productionNetwork = Get-ProductionNetworkState
  Write-Host "Fixed NIC verification: $(if($productionNetwork.Ready){'ready'}else{"not ready - $($productionNetwork.Reason)"})"
  if($DryRun){Write-Host "[DRY-RUN] $(if($existingInstall){'驗證既有安裝，必要時透過 update 切換 release；保留 canonical URL 與 port。'}else{'建立全新安裝。'})";Write-Host '[DRY-RUN] 不會建立目錄、Task Scheduler task、Firewall rule 或啟動程序。';return}
  $productionNetwork = Assert-ProductionNetwork
  Assert-MySqlPrerequisites $MySqlServiceName $nodeExecutable $adminCredentialSource $runtimeCredentialSource (Join-Path $package.Root 'db')
  foreach($dir in @('config','logs','run','backups','tools','db')){[IO.Directory]::CreateDirectory((Join-Path $InstallPath $dir))|Out-Null}
  $installedRuntimeCredential=Join-Path $InstallPath 'config\database.runtime.json'
  $installedAdminCredential=Join-Path $InstallPath 'config\database.admin.json'
  if(-not $runtimeCredentialSource.Equals($installedRuntimeCredential,[StringComparison]::OrdinalIgnoreCase)){Copy-ProtectedCredential $runtimeCredentialSource $installedRuntimeCredential}
  if(-not $adminCredentialSource.Equals($installedAdminCredential,[StringComparison]::OrdinalIgnoreCase)){Copy-ProtectedCredential $adminCredentialSource $installedAdminCredential}
  $databasePrepared=$false
  if($existingInstall){
    $savedConfig=Get-Content -Raw -Encoding UTF8 -LiteralPath $installedConfig|ConvertFrom-Json
    foreach($property in @{backupPath=(Join-Path $InstallPath 'backups');databaseConfigPath=$installedRuntimeCredential;adminDatabaseConfigPath=$installedAdminCredential;mysqlServiceName=$MySqlServiceName;nodePath=$nodeExecutable;networkPolicy='deployment-settings-v1';deploymentEnvironmentName=$DeploymentEnvironmentName;networkSubnet=$ProductionSubnet;networkPrefixLength=$ProductionPrefixLength;networkGateway=$ProductionGateway;allowedRemoteAddresses=$chosenRemote;bindAddress=$chosen;canonicalHost=$chosen;canonicalUrl="http://${chosen}:8080"}.GetEnumerator()){
      $savedConfig|Add-Member -NotePropertyName $property.Key -NotePropertyValue $property.Value -Force
      $Config|Add-Member -NotePropertyName $property.Key -NotePropertyValue $property.Value -Force
    }
    $savedConfig|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $installedConfig
    $currentRelease=Read-Release $Config.currentPath
    $hostMissing=-not(Test-Path -LiteralPath (Join-Path $Config.installPath 'tools\host\server.mjs') -PathType Leaf)
    if($hostMissing){throw '既有安裝缺少 production host；為避免建立無法 rollback 的狀態，未覆寫 release。'}
    if($currentRelease.version -ne $package.Release.version -or $currentRelease.build -ne $package.Release.build){
      $PackagePath=$package.Root
      Invoke-Update
      $databasePrepared=$true
    }else{Write-Host '既有安裝已是相同 version/build；不重寫 current release。'}
    if(-not $databasePrepared){
      Copy-Item -Path (Join-Path $package.Root 'db\*') -Destination (Join-Path $InstallPath 'db') -Recurse -Force
      foreach($databaseTool in @('backup.ps1','restore.ps1')){Copy-FileAtomically (Join-Path $package.Root "tools\database\$databaseTool") (Join-Path $InstallPath "tools\database\$databaseTool")}
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
    Copy-Item -Path (Join-Path $package.Root 'db\*') -Destination (Join-Path $InstallPath 'db') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $package.Root 'tools\database') -Destination (Join-Path $InstallPath 'tools\database') -Recurse -Force
    $installed=[ordered]@{port=8080;bindAddress=$chosen;canonicalHost=$chosen;canonicalUrl="http://${chosen}:8080";networkPolicy='deployment-settings-v1';deploymentEnvironmentName=$DeploymentEnvironmentName;networkSubnet=$ProductionSubnet;networkPrefixLength=$ProductionPrefixLength;networkGateway=$ProductionGateway;allowedRemoteAddresses=$chosenRemote;installPath=$InstallPath;currentPath=$current;logPath=(Join-Path $InstallPath 'logs');runPath=(Join-Path $InstallPath 'run');backupPath=(Join-Path $InstallPath 'backups');databaseConfigPath=$installedRuntimeCredential;adminDatabaseConfigPath=$installedAdminCredential;mysqlServiceName=$MySqlServiceName;nodePath=$nodeExecutable;healthIntervalSeconds=60;healthTimeoutSeconds=5;healthFailureThreshold=3;recoveryCooldownSeconds=120;maintenanceLockMinutes=15;logRetentionDays=14;logMaxBytes=5000000}
    $installed|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $installedConfig
  }
  Copy-FileAtomically (Join-Path $package.Root 'tools\wdwelt.ps1') (Join-Path $InstallPath 'tools\wdwelt.ps1')
  Copy-FileAtomically (Join-Path $package.Root 'tools\deployment.json') (Join-Path $InstallPath 'tools\deployment.json')
  if(-not $databasePrepared){
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\backup.mjs') --config $installedAdminCredential --output (Join-Path $InstallPath 'backups') --label pre-migration
    if($LASTEXITCODE-ne0){throw 'Pre-migration database backup failed; migration was not started.'}
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\migrate.mjs') --config $installedAdminCredential --migrations (Join-Path $InstallPath 'db\migrations')
    if($LASTEXITCODE-ne0){throw 'Database migration failed; WDWELT was not started.'}
  }
  & $nodeExecutable (Join-Path $InstallPath 'db\operations\runtime-check.mjs') --config $installedRuntimeCredential --require-schema
  if($LASTEXITCODE-ne0){throw 'G2 程式帳號缺少資料表或讀寫權限；未啟動 WDWELT。'}
  $installedTool=Join-Path $InstallPath 'tools\wdwelt.ps1'
  & $installedTool install-tasks -ConfigPath $installedConfig; if($LASTEXITCODE-ne0){throw 'Task Scheduler 安裝失敗。'}
  & $installedTool install-firewall -ConfigPath $installedConfig -AllowedRemoteAddress $chosenRemote -AllowPublicProfile:$AllowPublicProfile; if($LASTEXITCODE-ne0){throw 'Firewall rule 安裝失敗。'}
  & $installedTool start -ConfigPath $installedConfig; if($LASTEXITCODE-ne0){throw 'WDWELT 啟動或 health 驗證失敗。'}
  & $installedTool network -ConfigPath $installedConfig; if($LASTEXITCODE-ne0){throw 'Production network 最終驗證失敗。'}
  Remove-LegacyInstalledCredentials
  & $installedTool status -ConfigPath $installedConfig
  Write-Host "安裝成功：http://${chosen}:8080"
}

function Invoke-Update {
  if(-not $PackagePath){throw 'update 需要 -PackagePath。'}; $package=Validate-Package $PackagePath
  $transaction=[guid]::NewGuid().ToString('n');$stage=Join-Path $Config.runPath "stage-$transaction"
  $current=Join-Path $Config.installPath 'current';$previous=Join-Path $Config.installPath 'previous';$hostCurrent=Join-Path $Config.installPath 'tools\host';$hostPrevious=Join-Path $Config.runPath 'previous-host';$dbCurrent=Join-Path $Config.installPath 'db';$dbPrevious=Join-Path $Config.runPath 'previous-db'
  $failed=Join-Path $Config.runPath 'failed-release';$failedHost=Join-Path $Config.runPath 'failed-host';$failedDb=Join-Path $Config.runPath 'failed-db';$oldPrevious=Join-Path $Config.runPath "old-previous-$transaction";$oldPreviousHost=Join-Path $Config.runPath "old-previous-host-$transaction";$oldPreviousDb=Join-Path $Config.runPath "old-previous-db-$transaction"
  $original=Read-Release $current
  if(-not(Test-Path -LiteralPath (Join-Path $hostCurrent 'server.mjs') -PathType Leaf)){throw 'Current production host 不完整；update 未停止服務。'}
  $lockAcquired=$false;$serviceStopped=$false;$currentPreserved=$false;$newProductionActive=$false;$hostPreserved=$false;$newHostActive=$false;$dbPreserved=$false;$newDbActive=$false;$preserveArtifacts=$false
  try {
    [IO.Directory]::CreateDirectory($stage)|Out-Null
    Copy-Item -LiteralPath (Join-Path $package.Root 'production') -Destination (Join-Path $stage 'production') -Recurse
    Copy-Item -LiteralPath (Join-Path $package.Root 'host') -Destination (Join-Path $stage 'host') -Recurse
    Copy-Item -LiteralPath (Join-Path $package.Root 'db') -Destination (Join-Path $stage 'db') -Recurse
    if($Config.adminDatabaseConfigPath-and(Test-Path -LiteralPath $Config.adminDatabaseConfigPath -PathType Leaf)){Invoke-DatabaseBackup 'pre-migration' $package.Root}
    Acquire-MaintenanceLock 'update';$lockAcquired=$true
    Stop-Wdwelt -Maintenance;$serviceStopped=$true
    if($Config.adminDatabaseConfigPath-and(Test-Path -LiteralPath $Config.adminDatabaseConfigPath -PathType Leaf)){Invoke-DatabaseMigration $stage}
    if(Test-Path -LiteralPath $previous){Move-Item -LiteralPath $previous -Destination $oldPrevious}
    if(Test-Path -LiteralPath $hostPrevious){Move-Item -LiteralPath $hostPrevious -Destination $oldPreviousHost}
    if(Test-Path -LiteralPath $dbPrevious){Move-Item -LiteralPath $dbPrevious -Destination $oldPreviousDb}
    if(-not(Test-Path -LiteralPath $dbCurrent)){[IO.Directory]::CreateDirectory($dbCurrent)|Out-Null}
    Move-Item -LiteralPath $current -Destination $previous;$currentPreserved=$true
    Move-Item -LiteralPath (Join-Path $stage 'production') -Destination $current;$newProductionActive=$true
    Move-Item -LiteralPath $hostCurrent -Destination $hostPrevious;$hostPreserved=$true
    Move-Item -LiteralPath (Join-Path $stage 'host') -Destination $hostCurrent;$newHostActive=$true
    Move-Item -LiteralPath $dbCurrent -Destination $dbPrevious;$dbPreserved=$true
    Move-Item -LiteralPath (Join-Path $stage 'db') -Destination $dbCurrent;$newDbActive=$true
    Start-Wdwelt;$health=if(Test-DatabaseConfigured){Invoke-ReadyHealth}else{Invoke-LiveHealth}
    if(-not $health -or $health.version -ne $package.Release.version -or $health.build -ne $package.Release.build){throw '新版 /health/ready version/build 驗證失敗。'}
    foreach($databaseTool in @('backup.ps1','restore.ps1')){Copy-FileAtomically (Join-Path $package.Root "tools\database\$databaseTool") (Join-Path $Config.installPath "tools\database\$databaseTool")}
    Copy-FileAtomically (Join-Path $package.Root 'tools\wdwelt.ps1') (Join-Path $Config.installPath 'tools\wdwelt.ps1')
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
      if($newDbActive -and (Test-Path -LiteralPath $dbCurrent)){
        if(Test-Path -LiteralPath $failedDb){Remove-Item -LiteralPath $failedDb -Recurse -Force}
        Move-Item -LiteralPath $dbCurrent -Destination $failedDb
      }
      if($dbPreserved -and (Test-Path -LiteralPath $dbPrevious)){Move-Item -LiteralPath $dbPrevious -Destination $dbCurrent}
      if($newProductionActive -and (Test-Path -LiteralPath $current)){
        if(Test-Path -LiteralPath $failed){Remove-Item -LiteralPath $failed -Recurse -Force}
        Move-Item -LiteralPath $current -Destination $failed
      }
      if($currentPreserved -and (Test-Path -LiteralPath $previous)){Move-Item -LiteralPath $previous -Destination $current}
      if(Test-Path -LiteralPath $oldPrevious){Move-Item -LiteralPath $oldPrevious -Destination $previous}
      if(Test-Path -LiteralPath $oldPreviousHost){Move-Item -LiteralPath $oldPreviousHost -Destination $hostPrevious}
      if(Test-Path -LiteralPath $oldPreviousDb){Move-Item -LiteralPath $oldPreviousDb -Destination $dbPrevious}
      Start-Wdwelt;$restored=if(Test-DatabaseConfigured){Invoke-ReadyHealth}else{Invoke-LiveHealth}
      if(-not $restored -or $restored.version -ne $original.version -or $restored.build -ne $original.build){throw 'Original release health/version verification failed.'}
    }catch{$preserveArtifacts=$true;throw "Update failed; previous release restore also failed. Releases and logs were preserved. Cause: $updateError; restore error: $($_.Exception.Message)"}
    throw "Update failed; previous release restored. Cause: $updateError"
  }finally{
    if($lockAcquired){Release-MaintenanceLock}
    if(-not $preserveArtifacts){
      foreach($temporary in @($stage,$oldPrevious,$oldPreviousHost,$oldPreviousDb)){if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue}}
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
  $hostCurrent=Join-Path $Config.installPath 'tools\host';$hostPrevious=Join-Path $Config.runPath 'previous-host';$dbCurrent=Join-Path $Config.installPath 'db';$dbPrevious=Join-Path $Config.runPath 'previous-db'
  if(-not(Test-Path -LiteralPath (Join-Path $hostPrevious 'server.mjs') -PathType Leaf)){throw 'Previous release 缺少對應 production host，未停止服務。'}
  if(-not(Test-Path -LiteralPath $dbCurrent -PathType Container)-or-not(Test-Path -LiteralPath $dbPrevious -PathType Container)){throw 'Current／previous database tool pair 不完整，未停止服務。'}
  Write-Host "Current: $($currentRelease.version) build $($currentRelease.build); Previous: $($previousRelease.version) build $($previousRelease.build)"
  Acquire-MaintenanceLock 'rollback';$swap=Join-Path $Config.runPath 'rollback-swap';$hostSwap=Join-Path $Config.runPath 'host-swap';$dbSwap=Join-Path $Config.runPath 'db-swap';$releaseSwitched=$false;$hostSwitched=$false;$dbSwitched=$false
  if((Test-Path -LiteralPath $swap)-or(Test-Path -LiteralPath $hostSwap)-or(Test-Path -LiteralPath $dbSwap)){Release-MaintenanceLock;throw '發現 stale rollback swap directory；為避免覆寫 release，未停止服務。'}
  try {
    try {
      Stop-Wdwelt -Maintenance
      Switch-DirectoryPair $current $previous $swap;$releaseSwitched=$true
      Switch-DirectoryPair $hostCurrent $hostPrevious $hostSwap;$hostSwitched=$true
      Switch-DirectoryPair $dbCurrent $dbPrevious $dbSwap;$dbSwitched=$true
      Start-Wdwelt;$health=if(Test-DatabaseConfigured){Invoke-ReadyHealth}else{Invoke-LiveHealth}
      if(-not $health-or$health.version-ne$previousRelease.version-or$health.build-ne$previousRelease.build){throw 'Rollback health/version verification failed.'}
      Write-OperationLog info rollback 'Manual rollback completed.'
    }catch{
      $rollbackError=$_.Exception.Message
      if(-not $releaseSwitched){throw}
      try{
        if(Get-VerifiedHost){Stop-Wdwelt -Maintenance}
        if($dbSwitched){Switch-DirectoryPair $dbCurrent $dbPrevious $dbSwap}
        if($hostSwitched){Switch-DirectoryPair $hostCurrent $hostPrevious $hostSwap}
        Switch-DirectoryPair $current $previous $swap
        Start-Wdwelt;$restored=if(Test-DatabaseConfigured){Invoke-ReadyHealth}else{Invoke-LiveHealth}
        if(-not $restored-or$restored.version-ne$currentRelease.version-or$restored.build-ne$currentRelease.build){throw 'Original release health/version verification failed.'}
      }catch{throw "Rollback failed and original release restore also failed: $rollbackError; restore error: $($_.Exception.Message)"}
      throw "Rollback failed; original release restored. Cause: $rollbackError"
    }
  }finally{Release-MaintenanceLock}
}

try {
  switch($Command){
    start {Start-Wdwelt}; stop {Stop-Wdwelt}; restart {Restart-Wdwelt}; ensure {if(-not(Test-Path $ManualStopFile)-and-not(Invoke-LiveHealth)){Recover-Wdwelt}}
    health {$health=Invoke-Health;if(-not $health){throw 'Health check failed.'};$health|ConvertTo-Json}
    status {Show-Status}; recover {Recover-Wdwelt}; network {Test-Network}; logs {Show-Logs}
    power {Show-Power -ApplySettings:$Apply}; watchdog {Invoke-Watchdog}; boot {Invoke-Boot}; backup {Invoke-DatabaseBackup 'manual'}; restore {Invoke-DatabaseRestore $BackupFile}
    daily {Invoke-Watchdog -DailyReset}; install-tasks {Install-Tasks}; install-firewall {Install-Firewall}; package {Invoke-Package}; install {Invoke-Install}; update {Invoke-Update}; rollback {Invoke-Rollback}
  }
  exit 0
} catch {
  if(-not $DryRun){Write-OperationLog error $Command $_.Exception.Message}
  Write-Error $_.Exception.Message
  exit 1
}
