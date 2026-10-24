[CmdletBinding()]
param(
  [ValidateSet('Plan','Configure','Check','Enable','Status','Disable')]
  [string]$Mode = 'Plan',
  [string]$PublicOrigin,
  [switch]$EnableMasterRecovery,
  [string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ConfigPath) { $ConfigPath = Join-Path $repository 'config\local\funnel.host.json' }
elseif (-not [IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath = Join-Path $repository $ConfigPath }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$localConfigRoot = [IO.Path]::GetFullPath((Join-Path $repository 'config\local'))
if (-not $ConfigPath.StartsWith($localConfigRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Funnel host config 必須位於 Git-ignored config\local 內。'
}

function Assert-PublicOrigin([string]$Value) {
  if (-not $Value) { throw '請提供 -PublicOrigin https://<device>.<tailnet>.ts.net' }
  try { $uri = [Uri]$Value } catch { throw 'PublicOrigin 不是有效 URL。' }
  if ($uri.Scheme -ne 'https' -or -not $uri.Host.EndsWith('.ts.net',[StringComparison]::OrdinalIgnoreCase) -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    throw 'PublicOrigin 必須是沒有 path、query 或 credential 的 https://<device>.<tailnet>.ts.net origin。'
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

function Write-FunnelConfig([string]$Origin) {
  $development = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repository 'config\development.json') | ConvertFrom-Json
  $config = [ordered]@{}
  foreach ($property in $development.PSObject.Properties) { $config[$property.Name] = $property.Value }
  $config.exposureMode = 'tailscale-funnel'
  $config.publicOrigin = $Origin
  $config.canonicalUrl = $Origin
  $config.canonicalHost = ([Uri]$Origin).Host
  $config.bindAddress = '127.0.0.1'
  $config.allowRegistration = $false
  $config.allowMasterRecovery = [bool]$EnableMasterRecovery
  # The config moved one directory deeper under config/local.
  foreach ($name in @('installPath','currentPath','logPath','runPath','backupPath')) {
    $config[$name] = Join-Path '..' ([string]$development.$name)
  }
  $config.databaseConfigPath = 'database.runtime.json'
  $config.adminDatabaseConfigPath = 'database.admin.json'
  $config.developerAdminConfigPath = 'developer-admin.json'
  [IO.Directory]::CreateDirectory((Split-Path -Parent $ConfigPath)) | Out-Null
  $temporary = "$ConfigPath.$PID.tmp"
  $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
  Write-Host "Funnel host config: $ConfigPath"
}

function Get-Tailscale {
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if (-not $command) {
    $fallback = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw '找不到 tailscale.exe。請先從 Tailscale 官方安裝 Windows client 並登入 tailnet。'
  }
  return $command.Source
}

function Wait-Ready {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health/ready' -TimeoutSec 2
      if ($ready.status -eq 'ok') { return }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'WDWELT backend 未在 15 秒內 ready；Funnel 尚未啟用。'
}

function Assert-LoopbackListeners {
  $listeners = @(& netstat.exe -ano -p TCP | Where-Object { $_ -match '^\s*TCP\s+\S+:(3306|33060|8080)\s+\S+\s+LISTENING\s+\d+\s*$' })
  $database = @($listeners | Where-Object { $_ -match ':3306(?:0)?\s' })
  foreach ($line in $database) {
    if ($line -notmatch '^\s*TCP\s+(127\.0\.0\.1|\[::1\]):3306(?:0)?\s') {
      throw "MySQL classic/X listener 不是 localhost；拒絕啟用 Funnel：$($line.Trim())"
    }
  }
  $backend = @($listeners | Where-Object { $_ -match ':8080\s' })
  if ($backend.Count -ne 1 -or $backend[0] -notmatch '^\s*TCP\s+127\.0\.0\.1:8080\s') {
    throw 'WDWELT backend 必須且只能在 127.0.0.1:8080 LISTENING；拒絕啟用 Funnel。'
  }
}

if ($Mode -eq 'Plan') {
  Write-Host 'WDWELT Tailscale Funnel plan (no changes)'
  Write-Host '1. Generate config/local/funnel.host.json: loopback backend, HTTPS public origin, Secure cookies, same-origin writes.'
  Write-Host '2. Keep MySQL on localhost; do not add a TCP 3306 firewall rule.'
  Write-Host '3. Start the existing Node host on 127.0.0.1:8080.'
  Write-Host '4. Run: tailscale funnel --bg --https=443 http://127.0.0.1:8080'
  Write-Host '5. Registration and Master Recovery are public-disabled by default.'
  exit 0
}

if ($Mode -eq 'Status') {
  $tailscale = Get-Tailscale
  & $tailscale funnel status --json
  exit $LASTEXITCODE
}

if ($Mode -eq 'Disable') {
  $tailscale = Get-Tailscale
  & $tailscale funnel --https=443 off
  exit $LASTEXITCODE
}

if ($Mode -eq 'Check') {
  Wait-Ready
  Assert-LoopbackListeners
  Write-Host 'WDWELT Funnel local preflight passed: app/database ready; 8080 and MySQL listeners are loopback-only.'
  exit 0
}

$origin = Assert-PublicOrigin $PublicOrigin
Write-FunnelConfig $origin
if ($Mode -eq 'Configure') { exit 0 }

$tailscale = Get-Tailscale
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pidPath = Join-Path $repository 'runtime\run\host.pid.json'
$running = $false
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  try {
    $record = Get-Content -Raw -Encoding UTF8 -LiteralPath $pidPath | ConvertFrom-Json
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($process) {
      if ([IO.Path]::GetFullPath([string]$record.configPath) -ne $ConfigPath) { throw 'TCP 8080 已由非 Funnel config 的 WDWELT host 使用；請先正常停止該 host。' }
      $running = $true
    }
  } catch { if ($_.Exception.Message -like 'TCP 8080*') { throw } }
}
if (-not $running) {
  $server = Join-Path $repository 'server\app\server.mjs'
  Start-Process -FilePath $node -ArgumentList @($server,'--config',$ConfigPath) -WorkingDirectory $repository -WindowStyle Hidden | Out-Null
}
Wait-Ready
Assert-LoopbackListeners
& $tailscale funnel --bg --https=443 http://127.0.0.1:8080
if ($LASTEXITCODE -ne 0) { throw "tailscale funnel 啟用失敗（exit $LASTEXITCODE）。" }
& $tailscale funnel status
exit $LASTEXITCODE
