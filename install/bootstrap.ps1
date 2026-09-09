[CmdletBinding()]
param(
  [switch]$PlanOnly,
  [switch]$ExistingAccounts,
  [switch]$SkipTests,
  [switch]$FullValidation,
  [switch]$NonInteractive,
  [switch]$AllowPublicProfile,
  [switch]$Offline,
  [string]$MySqlServiceName,
  [string]$CanonicalHost,
  [string]$DeploymentSettingsPath,
  [string]$NodeInstallerPath,
  [string]$MySqlInstallerPath,
  [string]$NpmCachePath,
  [string]$InstallPath = "$env:ProgramData\WDWELT"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InstallDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $InstallDirectory '..'))
$ConfigRoot = Join-Path $RepositoryRoot 'config'
$LocalConfigRoot = Join-Path $ConfigRoot 'local'
$RuntimeRoot = Join-Path $RepositoryRoot 'runtime'
$BootstrapLog = $null
$PhaseNumber = 0
$PhaseCount = 13
$ProductionCanonicalHost = $null
$ProductionPrefixLength = 0
$ProductionSubnet = $null
$ProductionGateway = $null
$ProductionAllowedRemoteAddresses = @()
$DeploymentEnvironmentName = $null

function Write-BootstrapLog([string]$Level, [string]$Message) {
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] [$Level] $Message"
  if ($BootstrapLog) { Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value $line }
}

function Write-Phase([string]$Message) {
  $script:PhaseNumber += 1
  Write-Host "`n[$script:PhaseNumber/$script:PhaseCount] $Message" -ForegroundColor Cyan
  Write-BootstrapLog info "phase=$script:PhaseNumber message=$Message"
}

function Write-Detail([string]$Message) {
  Write-Host "  $Message"
  Write-BootstrapLog info $Message
}

function Confirm-Choice([string]$Prompt) {
  if ($NonInteractive) { return $true }
  $answer = Read-Host "$Prompt [y/N]"
  return $answer -match '^(?i:y|yes|是)$'
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-ElevatedIfNeeded {
  if (Test-Administrator) { return $false }
  Write-Host '需要 Administrator 權限；即將顯示 Windows UAC。' -ForegroundColor Yellow
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($switchName in @('ExistingAccounts','SkipTests','FullValidation','NonInteractive','AllowPublicProfile','Offline')) {
    if ((Get-Variable -Name $switchName -ValueOnly)) { $arguments += "-$switchName" }
  }
  foreach ($pair in @(
    @('MySqlServiceName',$MySqlServiceName),@('CanonicalHost',$CanonicalHost),@('DeploymentSettingsPath',$DeploymentSettingsPath),@('NodeInstallerPath',$NodeInstallerPath),
    @('MySqlInstallerPath',$MySqlInstallerPath),@('NpmCachePath',$NpmCachePath),@('InstallPath',$InstallPath)
  )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$pair[1])) {
      $quotedValue = '"' + ([string]$pair[1]).Replace('"', '\"') + '"'
      $arguments += @("-$($pair[0])", $quotedValue)
    }
  }
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($arguments -join ' ') -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Administrator bootstrap failed with exit code $($process.ExitCode)." }
  return $true
}

function Assert-RepositoryLayout {
  foreach ($relative in @('package.json','package-lock.json','install\wdwelt.ps1','config\database.admin.example.json','db\operations\migrate.mjs')) {
    $path = Join-Path $RepositoryRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Repository 不完整，缺少：$path" }
  }
}

function Resolve-BootstrapInputPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $resolved = if ([IO.Path]::IsPathRooted($Value)) { [IO.Path]::GetFullPath($Value) } else { [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Value)) }
  if (-not (Test-Path -LiteralPath $resolved)) { throw "找不到本機檔案或目錄：$resolved" }
  return $resolved
}

function Convert-DeploymentIPv4ToNumber([Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  return [uint64]$bytes[0] * 16777216 + [uint64]$bytes[1] * 65536 + [uint64]$bytes[2] * 256 + [uint64]$bytes[3]
}

function Get-DeploymentPrivateMinimumPrefix([Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  if ($bytes[0] -eq 10) { return 8 }
  if ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) { return 12 }
  if ($bytes[0] -eq 192 -and $bytes[1] -eq 168) { return 16 }
  return 0
}

function Get-DeploymentPrivateClass([Net.IPAddress]$Address) {
  $minimum = Get-DeploymentPrivateMinimumPrefix $Address
  if (-not $minimum) { return $null }
  return "$($Address.GetAddressBytes()[0]):$minimum"
}

function Assert-DeploymentRemoteAddress([string]$Value) {
  $value = $Value.Trim()
  if (-not $value -or $value -in @('*','Any','Internet','LocalSubnet','0.0.0.0/0')) { throw "allowedClientRanges 含有不安全或空白值：$value" }
  if ($value -match '^(.+)/(\d{1,2})$') {
    $address = $null; $prefix = [int]$Matches[2]
    if (-not [Net.IPAddress]::TryParse($Matches[1], [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw "allowedClientRanges CIDR 不合法：$value" }
    $minimum = Get-DeploymentPrivateMinimumPrefix $address
    if (-not $minimum -or $prefix -lt $minimum -or $prefix -gt 32) { throw "allowedClientRanges 必須完整位於 RFC1918 private range：$value" }
    $mask=[uint64]([Math]::Pow(2,32)-[Math]::Pow(2,32-$prefix))
    if(((Convert-DeploymentIPv4ToNumber $address)-band$mask)-ne(Convert-DeploymentIPv4ToNumber $address)){throw "allowedClientRanges CIDR 必須使用 network address：$value"}
    return
  }
  if ($value -match '^([^-]+)-([^-]+)$') {
    $first=$null; $last=$null
    if (-not [Net.IPAddress]::TryParse($Matches[1], [ref]$first) -or -not [Net.IPAddress]::TryParse($Matches[2], [ref]$last) -or
        $first.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $last.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        -not (Get-DeploymentPrivateMinimumPrefix $first) -or -not (Get-DeploymentPrivateMinimumPrefix $last) -or (Get-DeploymentPrivateClass $first) -ne (Get-DeploymentPrivateClass $last) -or
        (Convert-DeploymentIPv4ToNumber $first) -gt (Convert-DeploymentIPv4ToNumber $last)) { throw "allowedClientRanges range 不合法或不是 private IPv4：$value" }
    return
  }
  $single=$null
  if (-not [Net.IPAddress]::TryParse($value, [ref]$single) -or $single.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or -not (Get-DeploymentPrivateMinimumPrefix $single)) { throw "allowedClientRanges address 不合法或不是 private IPv4：$value" }
}

function Read-DeploymentSettings {
  $resolved = if ([string]::IsNullOrWhiteSpace($DeploymentSettingsPath)) { Join-Path $ConfigRoot 'deployment.json' } else { Resolve-BootstrapInputPath $DeploymentSettingsPath }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "找不到 deployment settings：$resolved" }
  try { $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolved | ConvertFrom-Json } catch { throw "deployment settings JSON 無法解析：$resolved" }
  if ([int]$settings.schemaVersion -ne 1) { throw 'deployment settings schemaVersion 必須為 1。' }
  if ([string]::IsNullOrWhiteSpace([string]$settings.environmentName)) { throw 'deployment settings 缺少 environmentName。' }
  $hostAddress=$null; $gateway=$null
  if (-not [Net.IPAddress]::TryParse([string]$settings.hostAddress,[ref]$hostAddress) -or $hostAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or -not (Get-DeploymentPrivateMinimumPrefix $hostAddress)) { throw 'hostAddress 必須是 private IPv4。' }
  if (-not [Net.IPAddress]::TryParse([string]$settings.defaultGateway,[ref]$gateway) -or $gateway.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or -not (Get-DeploymentPrivateMinimumPrefix $gateway)) { throw 'defaultGateway 必須是 private IPv4。' }
  if ([string]$settings.subnetCidr -notmatch '^(.+)/(\d{1,2})$') { throw 'subnetCidr 必須是 IPv4 CIDR。' }
  $subnet=$null; $prefix=[int]$Matches[2]
  if (-not [Net.IPAddress]::TryParse($Matches[1],[ref]$subnet) -or $subnet.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $prefix -lt 1 -or $prefix -gt 30) { throw 'subnetCidr 必須是可配置 host/gateway 的 IPv4 CIDR（prefix 1..30）。' }
  $minimum=Get-DeploymentPrivateMinimumPrefix $subnet
  if (-not $minimum -or $prefix -lt $minimum) { throw 'subnetCidr 必須完整位於 RFC1918 private range。' }
  $mask=[uint64]([Math]::Pow(2,32)-[Math]::Pow(2,32-$prefix)); $network=(Convert-DeploymentIPv4ToNumber $subnet) -band $mask
  if ((Convert-DeploymentIPv4ToNumber $subnet) -ne $network) { throw 'subnetCidr 必須使用 network address。' }
  if (((Convert-DeploymentIPv4ToNumber $hostAddress) -band $mask) -ne $network -or ((Convert-DeploymentIPv4ToNumber $gateway) -band $mask) -ne $network) { throw 'hostAddress 與 defaultGateway 必須位於 subnetCidr。' }
  $broadcast=$network+[uint64]([Math]::Pow(2,32-$prefix)-1);$hostNumber=Convert-DeploymentIPv4ToNumber $hostAddress;$gatewayNumber=Convert-DeploymentIPv4ToNumber $gateway
  if($hostNumber-in@($network,$broadcast)-or$gatewayNumber-in@($network,$broadcast)){throw 'hostAddress/defaultGateway 不可使用 network 或 broadcast address。'}
  $allowed=@($settings.allowedClientRanges | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if (-not $allowed.Count) { throw 'allowedClientRanges 不可為空。' }
  foreach($address in $allowed){Assert-DeploymentRemoteAddress $address}
  return [pscustomobject]@{Path=[IO.Path]::GetFullPath($resolved);EnvironmentName=[string]$settings.environmentName;HostAddress=$hostAddress.IPAddressToString;SubnetCidr=[string]$settings.subnetCidr;PrefixLength=$prefix;DefaultGateway=$gateway.IPAddressToString;AllowedClientRanges=$allowed}
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$Description, [int[]]$SuccessExitCodes = @(0)) {
  Write-Detail $Description
  $safeArguments = @($Arguments | ForEach-Object {
    if ($_ -match '^(?<name>[^=]*(?:password|passwd|token|secret)[^=]*)=') { "$($Matches.name)=***" } else { $_ }
  })
  Write-BootstrapLog info "execute=$FilePath arguments=$($safeArguments -join ' ')"
  & $FilePath @Arguments
  if ($LASTEXITCODE -notin $SuccessExitCodes) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-WingetPath {
  $command = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $command) { return $null }
  try { & $command.Source --version | Out-Null; if ($LASTEXITCODE -eq 0) { return $command.Source } } catch { return $null }
  return $null
}

function Get-NodePath {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $common = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path -LiteralPath $common -PathType Leaf) { return $common }
  return $null
}

function Assert-SupportedNode([string]$NodePath) {
  $versionText = (& $NodePath --version).Trim().TrimStart('v')
  $parts = $versionText.Split('.')
  if ($parts.Count -lt 2) { throw "無法解析 Node version：$versionText" }
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  $supported = ($major -eq 20 -and $minor -ge 19) -or ($major -eq 22 -and $minor -ge 12) -or ($major -ge 24)
  if (-not $supported) { throw "Node $versionText 不符合需求；請安裝目前的 Node.js LTS。" }
  Write-Detail "Node.js $versionText：OK"
}

function Install-LocalMsi([string]$Path, [string]$Description, [switch]$Passive) {
  $resolved = Resolve-BootstrapInputPath $Path
  if ([IO.Path]::GetExtension($resolved) -ne '.msi') { throw "$Description 必須是 .msi：$resolved" }
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne 'Valid') { throw "$Description 的 Authenticode signature 無法驗證：$($signature.Status)。" }
  $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
  Write-Detail "$Description local package SHA-256=$hash"
  $arguments = @('/i',$resolved,'/norestart')
  if ($Passive) { $arguments += '/passive' }
  Invoke-Native (Join-Path $env:SystemRoot 'System32\msiexec.exe') $arguments $Description @(0,3010)
}

function Ensure-Node {
  if ($ExistingAccounts) {
    $installedNode = Get-NodePath
    if (-not $installedNode) { throw '找不到已安裝的 Node.js；請先安裝 Node.js 與 npm。' }
    Assert-SupportedNode $installedNode
    return $installedNode
  }
  $node = Get-NodePath
  if (-not $node) {
    if (-not [string]::IsNullOrWhiteSpace($NodeInstallerPath)) {
      Install-LocalMsi $NodeInstallerPath '安裝預先準備的 Node.js MSI' -Passive
      Refresh-ProcessPath
      $node = Get-NodePath
    }
  }
  if (-not $node) {
    if ($Offline) {
      throw 'Offline 模式找不到 Node.js。請先準備官方 Node.js LTS .msi，並以 -NodeInstallerPath 指定。'
    }
    $winget = Get-WingetPath
    if (-not $winget) {
      Start-Process 'https://nodejs.org/en/download'
      throw '找不到 Node.js 與可用的 WinGet。已開啟 Node.js 官方下載頁；安裝 LTS、重新執行 START-WDWELT.cmd。'
    }
    Invoke-Native $winget @('install','--id','OpenJS.NodeJS.LTS','-e','--source','winget','--silent','--accept-source-agreements','--accept-package-agreements') '使用 WinGet 安裝 Node.js LTS'
    Refresh-ProcessPath
    $node = Get-NodePath
  }
  if (-not $node) { throw 'Node.js 安裝完成後仍找不到 node.exe；請重新啟動 Windows 再執行。' }
  Assert-SupportedNode $node
  return [IO.Path]::GetFullPath($node)
}

function Get-MySqlExecutable($Service) {
  if ($Service) {
    $serviceExecutable = [regex]::Match([string]$Service.PathName, '(?i)^\s*(?:"([^"]*mysqld\.exe)"|([^"\s]*mysqld\.exe))')
    if ($serviceExecutable.Success) {
      $mysqldPath = if ($serviceExecutable.Groups[1].Success) { $serviceExecutable.Groups[1].Value } else { $serviceExecutable.Groups[2].Value }
      $matchingClient = Join-Path (Split-Path -Parent $mysqldPath) 'mysql.exe'
      if (Test-Path -LiteralPath $matchingClient -PathType Leaf) { return $matchingClient }
      return $null
    }
  }
  $candidates = @('C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe')
  if (Test-Path -LiteralPath 'C:\Program Files\MySQL') {
    $candidates += @(Get-ChildItem -LiteralPath 'C:\Program Files\MySQL' -Filter mysql.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
  }
  return $candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Get-MySqlDumpExecutable([string]$MySqlExecutable) {
  $candidate = Join-Path (Split-Path -Parent $MySqlExecutable) 'mysqldump.exe'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "找不到 mysqldump.exe：$candidate" }
  return $candidate
}

function Assert-SupportedMySql([string]$MySqlExecutable) {
  $versionText = ((& $MySqlExecutable --version) -join ' ').Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(?i)\bVer\s+8\.') {
    throw "需要 MySQL Server 8.x client；偵測結果：$versionText"
  }
  Write-Detail "MySQL client：$versionText"
}

function Get-MySqlServices {
  return @(Get-CimInstance Win32_Service | Where-Object { $_.PathName -match '(?i)mysqld(?:\.exe)?' })
}

function Open-MySqlInstaller {
  if (-not [string]::IsNullOrWhiteSpace($MySqlInstallerPath)) {
    $resolvedInstaller = Resolve-BootstrapInputPath $MySqlInstallerPath
    if ($Offline -and [IO.Path]::GetFileName($resolvedInstaller) -match '(?i)web-community') {
      throw 'Offline 模式不能使用 MySQL web installer；請準備包含 Server 的 mysql-installer-community full bundle。'
    }
    Install-LocalMsi $resolvedInstaller '安裝預先準備的 MySQL Installer MSI'
  } elseif (-not $Offline) {
    $winget = Get-WingetPath
    if ($winget) {
      try { Invoke-Native $winget @('install','--id','Oracle.MySQL','-e','--source','winget','--interactive','--accept-source-agreements','--accept-package-agreements') '啟動官方 MySQL Installer' }
      catch { Write-Detail "WinGet 無法完成 MySQL Installer：$($_.Exception.Message)" }
    }
  }
  $installerCandidates = @(
    'C:\Program Files (x86)\MySQL\MySQL Installer for Windows\MySQLInstaller.exe',
    'C:\Program Files\MySQL\MySQL Installer for Windows\MySQLInstaller.exe'
  )
  $installer = $installerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $installer) {
    if ($Offline) { throw 'Offline 模式找不到 MySQL Installer。請準備 mysql-installer-community full bundle 並以 -MySqlInstallerPath 指定。' }
    Start-Process 'https://dev.mysql.com/downloads/windows/installer/'
    throw '找不到 MySQL Installer。已開啟官方下載頁；安裝 MySQL Installer 後重新執行 START-WDWELT.cmd。'
  }
  Write-Host @'

MySQL wizard 中請選：
  - MySQL Server 8.0 / Server only
  - Development Computer
  - TCP/IP 3306
  - 取消 Open Windows Firewall port
  - Strong Password Encryption
  - Service name MySQL80（或記下實際名稱）
  - Start at System Startup
  - 設定並保存 root 密碼

關閉 MySQL Installer 後 bootstrap 會自動繼續。
'@ -ForegroundColor Yellow
  if ($Offline) { Write-Host 'MySQL Installer 若詢問 Internet，請選擇 offline mode；full bundle 已包含 Server。' -ForegroundColor Yellow }
  Start-Process -FilePath $installer -Wait
}

function Select-MySqlService {
  $services = @(Get-MySqlServices)
  if (-not [string]::IsNullOrWhiteSpace($MySqlServiceName)) {
    $match = $services | Where-Object Name -EQ $MySqlServiceName | Select-Object -First 1
    if (-not $match) { throw "找不到指定的 MySQL service：$MySqlServiceName" }
    return $match
  }
  if ($services.Count -eq 0) { return $null }
  if ($services.Count -eq 1) { return $services[0] }
  if ($NonInteractive) { throw '偵測到多個 MySQL services；NonInteractive 模式必須提供 -MySqlServiceName。' }
  Write-Host '偵測到多個 MySQL services：' -ForegroundColor Yellow
  for ($index = 0; $index -lt $services.Count; $index += 1) { Write-Host "  [$($index + 1)] $($services[$index].Name) - $($services[$index].PathName)" }
  $selection = Read-Host '請輸入編號'
  $number = 0
  if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $services.Count) { throw 'MySQL service 選擇不合法。' }
  return $services[$number - 1]
}

function Ensure-MySqlService {
  $service = Select-MySqlService
  $mysql = if ($service) { Get-MySqlExecutable $service } else { $null }
  if (-not $service -or -not $mysql) {
    if ($ExistingAccounts) { throw '找不到已安裝的 MySQL service/client；請確認 MySQL Server 與 command-line tools 已安裝。' }
    Open-MySqlInstaller
    $service = Select-MySqlService
    $mysql = if ($service) { Get-MySqlExecutable $service } else { $null }
  }
  if (-not $service -or -not $mysql) { throw 'MySQL Server 8.0 尚未完整安裝；請完成 wizard 後重跑 bootstrap。' }
  Assert-SupportedMySql $mysql
  Set-Service -Name $service.Name -StartupType Automatic
  $controller = Get-Service -Name $service.Name
  if ($controller.Status -ne 'Running') { Start-Service -Name $service.Name; $controller.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }
  Write-Detail "MySQL service $($service.Name)：Running / Automatic"
  return [pscustomobject]@{ Service = $service; MySql = [IO.Path]::GetFullPath($mysql); MySqlDump = [IO.Path]::GetFullPath((Get-MySqlDumpExecutable $mysql)) }
}

function Find-MyIni($Service) {
  $pathText = [string]$Service.PathName
  $match = [regex]::Match($pathText, '(?i)--defaults-file(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
  if ($match.Success) {
    $candidate = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
  }
  $common = 'C:\ProgramData\MySQL\MySQL Server 8.0\my.ini'
  if (Test-Path -LiteralPath $common -PathType Leaf) { return $common }
  $found = Get-ChildItem -LiteralPath 'C:\ProgramData\MySQL' -Filter my.ini -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { return [IO.Path]::GetFullPath($found) }
  throw '找不到 MySQL my.ini；請用 MySQL Installer Reconfigure 檢查設定位置。'
}

function Set-LocalhostBind([string]$MyIni, [string]$ServiceName) {
  $original = [IO.File]::ReadAllText($MyIni)
  $lines = [Collections.Generic.List[string]]::new()
  [regex]::Split($original, '\r?\n') | ForEach-Object { $lines.Add($_) }
  $sectionIndex = -1
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index] -match '^\s*\[mysqld\]\s*$') { $sectionIndex = $index; break }
  }
  if ($sectionIndex -lt 0) { throw "my.ini 缺少 [mysqld] section：$MyIni" }
  $nextSection = $lines.Count
  for ($index = $sectionIndex + 1; $index -lt $lines.Count; $index += 1) { if ($lines[$index] -match '^\s*\[[^]]+\]\s*$') { $nextSection = $index; break } }
  $settingPattern = '^\s*(?:bind[-_]address|mysqlx[-_]bind[-_]address)\s*='
  for ($index = $nextSection - 1; $index -gt $sectionIndex; $index -= 1) { if ($lines[$index] -match $settingPattern) { $lines.RemoveAt($index) } }
  $lines.Insert($sectionIndex + 1, 'mysqlx-bind-address=127.0.0.1')
  $lines.Insert($sectionIndex + 1, 'bind-address=127.0.0.1')
  $newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
  $updated = [string]::Join($newline, $lines)
  if ($updated -eq $original) { Write-Detail 'MySQL classic/X Protocol bind 已是 localhost。'; return }
  $bytes = [IO.File]::ReadAllBytes($MyIni)
  $withBom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
  $encoding = [Text.UTF8Encoding]::new($withBom)
  $backup = "$MyIni.wdwelt-before-localhost-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
  Copy-Item -LiteralPath $MyIni -Destination $backup
  try {
    [IO.File]::WriteAllText($MyIni, $updated, $encoding)
    Restart-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  } catch {
    Copy-Item -LiteralPath $backup -Destination $MyIni -Force
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    throw "MySQL localhost bind 套用失敗，已還原 $backup。原因：$($_.Exception.Message)"
  }
  Write-Detail "MySQL 3306 與 X Protocol 已限制到 127.0.0.1；原設定備份：$backup"
}

function Protect-LocalFile([string]$Path) {
  $account = (& whoami.exe).Trim()
  & icacls.exe $Path '/inheritance:r' '/grant:r' "${account}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "無法保護 credential ACL：$Path" }
}

function Write-ProtectedJson([string]$Path, $Value) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  $temporary = "$Path.$PID.tmp"
  if (Test-Path -LiteralPath $temporary) { throw "Temporary credential file 已存在：$temporary" }
  try {
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 5) + "`n"), [Text.UTF8Encoding]::new($false))
    Protect-LocalFile $temporary
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Protect-LocalFile $Path
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Read-AdminConfig([string]$MySqlPath, [string]$MySqlDumpPath) {
  $configPath = Join-Path $LocalConfigRoot 'database.admin.json'
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    if ($existing -isnot [pscustomobject]) { throw 'Administrative database config 必須是單一 JSON object。未覆寫原檔。' }
    $required = @('host','port','database','user','password')
    $missing = @($required | Where-Object { $_ -notin @($existing.PSObject.Properties.Name) })
    if ($missing.Count -gt 0) { throw "Administrative database config 缺少欄位：$($missing -join ', ')。未覆寫原檔。" }
    if ($existing.password -and $existing.password -notmatch '^REPLACE_') {
      $existing | Add-Member -NotePropertyName mysqlClientPath -NotePropertyValue $MySqlPath -Force
      $existing | Add-Member -NotePropertyName mysqlDumpPath -NotePropertyValue $MySqlDumpPath -Force
      Write-ProtectedJson $configPath $existing
      Write-Detail '使用既有受保護 administrative database config。'
      return [pscustomobject]@{ Path = $configPath; Config = $existing }
    }
  }
  if ($NonInteractive) { throw 'NonInteractive 模式需要既有 config/local/database.admin.json。' }
  $secure = Read-Host '請輸入 MySQL root 密碼（畫面不會顯示）' -AsSecureString
  if ($secure.Length -eq 0) { throw 'MySQL root 密碼不可為空。' }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $config = [ordered]@{
      host='127.0.0.1';port=3306;database='g2';user='root';password=$plain
      connectionLimit=2;connectTimeoutMs=3000;readyTimeoutMs=2000;reconnectInitialSeconds=1;reconnectMaxSeconds=30
      sessionDurationHours=12;sessionCleanupMinutes=60;mysqlDumpPath=$MySqlDumpPath;mysqlClientPath=$MySqlPath
    }
    Write-ProtectedJson $configPath $config
    Write-Detail "已建立並保護 administrative config：$configPath"
    return [pscustomobject]@{ Path = $configPath; Config = [pscustomobject]$config }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $plain = $null
  }
}

function Read-ExistingAccountConfig([string]$Role, [string]$MySqlPath, [string]$MySqlDumpPath, [int]$DefaultPort = 3306) {
  $configPath = Join-Path $LocalConfigRoot "database.$Role.json"
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    foreach ($name in @('host','port','database','user','password')) {
      if ($name -notin @($config.PSObject.Properties.Name)) { throw "${configPath} 缺少 $name；請修正設定後重跑。" }
    }
    if (-not $config.password -or $config.password -match '^REPLACE_') { throw "${configPath} 尚未填入有效密碼；請填入後重跑。" }
  } else {
    if ($NonInteractive) { throw "ExistingAccounts 模式需要 $configPath；或以互動模式輸入既有帳號。" }
    $description = if ($Role -eq 'admin') { '安裝／備份帳號（需 G2 建表與備份權限）' } else { '程式讀寫帳號（G2 專用帳號）' }
    $accountName = (Read-Host "請輸入既有 MySQL $description 名稱").Trim()
    if (-not $accountName) { throw '帳號不可為空。' }
    $portText = Read-Host "MySQL TCP port [${DefaultPort}]"
    $portNumber = $DefaultPort
    if ($portText -and (-not [int]::TryParse($portText, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535)) { throw 'MySQL port 不合法。' }
    $secure = Read-Host "請輸入 $description 密碼（畫面不會顯示）" -AsSecureString
    if (-not $secure.Length) { throw '密碼不可為空。' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $config = [pscustomobject]@{host='127.0.0.1';port=$portNumber;database='g2';user=$accountName;password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }
  if ($config.host -notin @('127.0.0.1','localhost','::1') -or $config.database -ne 'g2') { throw '既有帳號設定必須連到 localhost 的 g2 database。' }
  $config | Add-Member -NotePropertyName mysqlClientPath -NotePropertyValue $MySqlPath -Force
  $config | Add-Member -NotePropertyName mysqlDumpPath -NotePropertyValue $MySqlDumpPath -Force
  Write-ProtectedJson $configPath $config
  return [pscustomobject]@{Path=$configPath;Config=$config}
}

function Quote-MySqlOption([string]$Value) {
  if ($Value -match '[\r\n]') { throw 'MySQL credential 含有不合法換行。' }
  return '"' + $Value.Replace('\','\\').Replace('"','\"') + '"'
}

function New-TemporaryMySqlOptionFile($Config) {
  $path = Join-Path ([IO.Path]::GetTempPath()) "wdwelt-bootstrap-$([guid]::NewGuid().ToString('n')).cnf"
  $content = @(
    '[client]',
    "host=$(Quote-MySqlOption ([string]$Config.host))",
    "port=$([int]$Config.port)",
    "user=$(Quote-MySqlOption ([string]$Config.user))",
    "password=$(Quote-MySqlOption ([string]$Config.password))",
    ''
  ) -join "`n"
  [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
  Protect-LocalFile $path
  return $path
}

function Ensure-G2Database([string]$MySqlPath, $AdminConfig) {
  $database = [string]$AdminConfig.database
  if ($database -notmatch '^[A-Za-z0-9_]+$') { throw "Database 名稱只可包含英文字母、數字與底線：$database" }
  $statement = 'CREATE DATABASE IF NOT EXISTS `{0}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;' -f $database
  $optionFile = New-TemporaryMySqlOptionFile $AdminConfig
  try {
    Invoke-Native $MySqlPath @("--defaults-extra-file=$optionFile",'--protocol=TCP',"--execute=$statement") "建立或確認 $database database"
  } finally { Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue }
}

function Get-NpmPath([string]$NodePath) {
  $candidate = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw '找不到 npm.cmd；請重新安裝 Node.js LTS。'
}

function Invoke-Node([string]$NodePath, [string[]]$Arguments, [string]$Description) {
  Invoke-Native $NodePath $Arguments $Description
}

function Get-LanCandidates {
  $values = @(Get-NetIPConfiguration -ErrorAction Stop | Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address
  } | ForEach-Object {
    foreach ($address in @($_.IPv4Address)) {
      if ($address.IPAddress -and $address.IPAddress -ne '127.0.0.1' -and $address.IPAddress -notlike '169.254.*') {
        [pscustomobject]@{
          Address=$address.IPAddress; PrefixLength=[int]$address.PrefixLength; InterfaceAlias=$_.InterfaceAlias
          InterfaceIndex=$_.InterfaceIndex; Gateway=@($_.IPv4DefaultGateway.NextHop)
        }
      }
    }
  })
  return @($values | Sort-Object Address -Unique)
}

function Assert-ProductionNetwork {
  if (-not $CanonicalHost.Equals($ProductionCanonicalHost, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Canonical host 必須符合 $DeploymentSettingsPath 內的 $ProductionCanonicalHost；拒絕使用 $CanonicalHost。"
  }
  $candidates = @(Get-LanCandidates)
  $match = $candidates | Where-Object Address -EQ $ProductionCanonicalHost | Select-Object -First 1
  if (-not $match) {
    $detected = if ($candidates.Count) { ($candidates | ForEach-Object { "$($_.Address)/$($_.PrefixLength) [$($_.InterfaceAlias)]" }) -join ', ' } else { 'none' }
    throw "本機尚未配置 IT 指定的 $ProductionCanonicalHost/$ProductionPrefixLength；目前偵測：$detected。Bootstrap 不會自行修改 NIC。"
  }
  if ([int]$match.PrefixLength -ne $ProductionPrefixLength) {
    throw "固定 IP 的 prefix 應為 /$ProductionPrefixLength，目前為 /$($match.PrefixLength)。Bootstrap 不會自行修改 NIC。"
  }
  if ($ProductionGateway -notin @($match.Gateway)) {
    throw "固定網路 gateway 應為 $ProductionGateway，目前為 $(@($match.Gateway) -join ', ')。Bootstrap 不會自行修改 NIC。"
  }
  Write-Detail "Production network：$ProductionCanonicalHost/$ProductionPrefixLength via $ProductionGateway [$($match.InterfaceAlias)]"
  return $ProductionCanonicalHost
}

function Show-Plan {
  if ($ExistingAccounts) {
    Write-Host 'ExistingAccounts：使用已安裝的 Node.js/MySQL 與既有 g2 database；輸入或讀取安裝／備份及程式讀寫帳號。不建立帳號、不重設密碼、不修改權限或 MySQL 設定。'
    Write-Host '流程：固定網路檢查 → 既有服務／帳號檢查 → npm ci → build/package → installer dry-run → 備份／migration → 安裝及健康檢查。'
    Write-Host "部署設定：$DeploymentSettingsPath；網址：http://${ProductionCanonicalHost}:8080/"
    return
  }
  Write-Host @"
WDWELT one-file bootstrap plan
  Preflight: validate repository and request Administrator through Windows UAC
  Settings: $DeploymentEnvironmentName from $DeploymentSettingsPath
  1. Require $ProductionCanonicalHost/$ProductionPrefixLength and gateway $ProductionGateway
  2. Detect or install Node.js LTS
  3. Detect MySQL Server 8.0; open the official wizard if absent
  4. Back up my.ini and bind MySQL classic/X Protocol to 127.0.0.1
  5. Securely prompt for MySQL root password and create the database
  6. Install locked npm dependencies (online, or a supplied offline cache)
  7. Validate the administrative database connection
  8. Create and verify the least-privilege runtime account
  9. Skip development tests by default; run them only with -FullValidation
 10. Build the production release
 11. Create and validate the production package
 12. Run the installer dry-run and show a final confirmation
 13. Install tasks and a $($ProductionAllowedRemoteAddresses -join ', ')-only firewall rule, then verify URLs

The bootstrap never changes Windows NIC settings, never exposes MySQL classic/X Protocol to the LAN, and never writes passwords to its log.
"@
}

function Main {
  Assert-RepositoryLayout
  Show-Plan
  if ($PlanOnly) { Write-Host 'PlanOnly：未變更任何檔案、service、package、task 或 firewall。'; return }
  if (Restart-ElevatedIfNeeded) { return }

  [IO.Directory]::CreateDirectory((Join-Path $RuntimeRoot 'logs')) | Out-Null
  $script:BootstrapLog = Join-Path $RuntimeRoot "logs\bootstrap-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss')).log"
  Write-BootstrapLog info "bootstrap_start repository=$RepositoryRoot"
  if (-not (Confirm-Choice '以上流程會安裝/設定軟體並在最後再次確認正式部署。是否繼續？')) { throw '使用者取消 bootstrap。' }

  Write-Phase '驗證 IT 指定的固定校內網路'
  $lanIp = Assert-ProductionNetwork

  Write-Phase '檢查或安裝 Node.js LTS'
  $node = Ensure-Node
  $npm = Get-NpmPath $node

  Write-Phase '檢查或安裝 MySQL Server 8.0'
  $mysqlState = Ensure-MySqlService
  $serviceName = $mysqlState.Service.Name

  Write-Phase '備份 MySQL 設定並限制到 localhost'
  if ($ExistingAccounts) { Write-Detail '保留 IT 已配置的 MySQL 設定；正式安裝前驗證 localhost 綁定。' }
  else {
    $myIni = Find-MyIni $mysqlState.Service
    Set-LocalhostBind $myIni $serviceName
  }

  Write-Phase '建立 administrative config 與 g2 database'
  if ($ExistingAccounts) {
    $admin = Read-ExistingAccountConfig 'admin' $mysqlState.MySql $mysqlState.MySqlDump
    $existingRuntime = Read-ExistingAccountConfig 'runtime' $mysqlState.MySql $mysqlState.MySqlDump ([int]$admin.Config.port)
    if ($admin.Config.port -ne $existingRuntime.Config.port) { throw '安裝與程式帳號必須連到相同 MySQL port。' }
  } else {
    $admin = Read-AdminConfig $mysqlState.MySql $mysqlState.MySqlDump
    Ensure-G2Database $mysqlState.MySql $admin.Config
  }

  Write-Phase '安裝 WDWELT JavaScript dependencies'
  $npmArguments = @('ci','--include=dev','--no-audit','--fund=false')
  if ($Offline) {
    $offlineCache = Resolve-BootstrapInputPath $NpmCachePath
    if (-not $offlineCache -or -not (Test-Path -LiteralPath $offlineCache -PathType Container)) {
      throw 'Offline 模式需要預先填好的 npm cache directory；請以 -NpmCachePath 指定。'
    }
    $npmArguments += @('--offline','--cache',$offlineCache)
  }
  Invoke-Native $npm $npmArguments "npm ci$(if($Offline){' --offline'}else{''})"

  Write-Phase '驗證 administrative database connection'
  Invoke-Node $node @('db\operations\preflight.mjs','--config',$admin.Path) 'database preflight'

  Write-Phase '建立或驗證最小權限 runtime account'
  $runtimeConfig = Join-Path $LocalConfigRoot 'database.runtime.json'
  if (-not $ExistingAccounts) {
    Invoke-Node $node @('db\operations\bootstrap.mjs','--admin-config',$admin.Path,'--runtime-config',$runtimeConfig) 'runtime account bootstrap'
  }
  Invoke-Node $node @('db\operations\runtime-check.mjs','--config',$runtimeConfig) 'runtime database readiness'

  Write-Phase '選擇性執行 development validation'
  if ($FullValidation -and -not $SkipTests) {
    Invoke-Native $npm @('test','--','--run') 'unit tests'
    Invoke-Native $npm @('run','typecheck') 'TypeScript typecheck'
    Invoke-Native $npm @('run','test:db','--','--config',$admin.Path) 'isolated database integration'
    Invoke-Native $npm @('run','test:restore','--','--config',$admin.Path) 'isolated restore integration'
  } else { Write-Detail '快速 production install：跳過 development tests；需要完整驗證時使用 -FullValidation。' }

  Write-Phase '建立 production build'
  Invoke-Native $npm @('run','build') 'production build'

  Write-Phase '建立並驗證 production package'
  $manager = Join-Path $InstallDirectory 'wdwelt.ps1'
  $packageRoot = Join-Path $RepositoryRoot 'artifacts\wdwelt-package'
  & $manager package -PackagePath $packageRoot
  if ($LASTEXITCODE -ne 0) { throw 'Production package 建立失敗。' }
  $packageTool = Join-Path $packageRoot 'tools\wdwelt.ps1'

  Write-Phase '執行正式 installer dry-run'
  $installParameters = @{
    InstallPath=$InstallPath; CanonicalHost=$lanIp; AllowedRemoteAddress=$ProductionAllowedRemoteAddresses
    NodePath=$node; MySqlServiceName=$serviceName; DatabaseConfigPath=$runtimeConfig; AdminDatabaseConfigPath=$admin.Path
    AllowPublicProfile=[bool]$AllowPublicProfile; DeploymentSettingsPath=(Join-Path $packageRoot 'tools\deployment.json')
  }
  & $packageTool install @installParameters -DryRun
  if ($LASTEXITCODE -ne 0) { throw 'Installer dry-run 失敗；未執行正式安裝。' }

  Write-Phase '確認並執行正式安裝'
  Write-Host "InstallPath：$InstallPath"
  Write-Host "MySQL service：$serviceName"
  Write-Host "PC URL：http://${lanIp}:8080/"
  Write-Host "iPhone URL：http://${lanIp}:8080/"
  Write-Host "Firewall remote scope：$($ProductionAllowedRemoteAddresses -join ', ') only"
  if (-not (Confirm-Choice "確認建立 scheduled tasks、僅允許 $($ProductionAllowedRemoteAddresses -join ', ') 的 TCP 8080 firewall rule 並啟動 WDWELT？")) { throw '使用者在正式安裝前取消；prerequisites、DB 與 package 已準備完成。' }
  & $packageTool install @installParameters
  if ($LASTEXITCODE -ne 0) { throw '正式安裝失敗；請查看上方錯誤與 bootstrap log。' }

  Write-BootstrapLog info 'bootstrap_complete'
  Write-Host "`nWDWELT 安裝完成。" -ForegroundColor Green
  Write-Host "PC：http://${lanIp}:8080/"
  Write-Host "iPhone：http://${lanIp}:8080/"
  Write-Host "Log：$BootstrapLog"
}

try {
  $deploymentSettings = Read-DeploymentSettings
  $script:DeploymentSettingsPath = $deploymentSettings.Path
  $script:DeploymentEnvironmentName = $deploymentSettings.EnvironmentName
  $script:ProductionCanonicalHost = $deploymentSettings.HostAddress
  $script:ProductionPrefixLength = $deploymentSettings.PrefixLength
  $script:ProductionSubnet = $deploymentSettings.SubnetCidr
  $script:ProductionGateway = $deploymentSettings.DefaultGateway
  $script:ProductionAllowedRemoteAddresses = @($deploymentSettings.AllowedClientRanges)
  if ([string]::IsNullOrWhiteSpace($CanonicalHost)) { $script:CanonicalHost = $ProductionCanonicalHost }
  elseif (-not $CanonicalHost.Equals($ProductionCanonicalHost,[StringComparison]::OrdinalIgnoreCase)) { throw "CanonicalHost 必須符合 deployment settings：$ProductionCanonicalHost" }
  Set-Location -LiteralPath $RepositoryRoot
  Main
  exit 0
} catch {
  Write-BootstrapLog error $_.Exception.Message
  Write-Host "`n安裝停止：$($_.Exception.Message)" -ForegroundColor Red
  if ($BootstrapLog) { Write-Host "Log：$BootstrapLog" }
  exit 1
}
