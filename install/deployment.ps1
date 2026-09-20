# Loaded by wdwelt.ps1; all paths are scoped to its validated install root.
function Invoke-Install {
  $stageName = 'Preflight'
  $rollbackResult = 'NOT REQUIRED'
  $databaseResult = 'UNCHANGED'
  $lockAcquired = $false
  $stopped = $false
  $activated = [Collections.Generic.List[object]]::new()
  $backup = $null
  $originalConfig = $null
  $originalTools = @{}
  $snapshot = $null
  try {
    $packageInput = if ($PackagePath) {$PackagePath} else {Split-Path -Parent $ScriptRoot}
    $package = Validate-Package $packageInput
    $installedConfig = Join-Path $InstallPath 'config\wdwelt.json'
    if (-not $ConfigPath.Equals($installedConfig,[StringComparison]::OrdinalIgnoreCase)) { throw 'Install ConfigPath must belong to the target installation.' }
    $nodeExecutable = if ($NodePath) {Resolve-InputPath $NodePath} else {(Get-Command node -ErrorAction Stop).Source}
    $installedAdmin = Join-Path $InstallPath 'config\database.admin.json'
    $installedRuntime = Join-Path $InstallPath 'config\database.runtime.json'
    $adminSource = if (Test-Path -LiteralPath $installedAdmin) {$installedAdmin} elseif ($AdminDatabaseConfigPath) {Resolve-InputPath $AdminDatabaseConfigPath} else {$null}
    $runtimeSource = if (Test-Path -LiteralPath $installedRuntime) {$installedRuntime} elseif ($DatabaseConfigPath) {Resolve-InputPath $DatabaseConfigPath} else {$null}
    if (-not $adminSource -or -not (Test-Path -LiteralPath $adminSource)) { throw 'Administrative database configuration is required.' }
    $chosen = if ($CanonicalHost) {$CanonicalHost} else {$ProductionCanonicalHost}
    if ($chosen -ne $ProductionCanonicalHost) { throw 'Canonical host must match deployment settings.' }
    $remote = if (@($AllowedRemoteAddress).Count) {@($AllowedRemoteAddress)} else {@($ProductionAllowedRemoteAddresses)}
    $remote = @(Assert-AllowedRemoteAddresses $remote)
    $mode = 'Fresh Install'
    if ((Test-Path -LiteralPath $installedConfig) -or (Test-Path -LiteralPath (Join-Path $InstallPath 'current')) -or (Test-Path -LiteralPath (Join-Path $InstallPath 'tools\host'))) {
      $mode = 'Repair / Reinstall'
      try {
        $oldRelease = Read-Release (Join-Path $InstallPath 'current')
        if ($oldRelease.build -ne $package.Release.build) {$mode = 'Update'}
        if (-not (Test-Path -LiteralPath (Join-Path $InstallPath 'tools\host\server.mjs'))) {$mode = 'Repair'}
      } catch { $mode = 'Repair' }
    }
    Write-Host "Deployment mode: $mode"
    if ($DryRun) {
      Write-Host "[DRY-RUN] $chosen`:8080; backup, preserve data, replace application, migrate, verify recovery and health."
      return
    }
    if (-not (Test-Administrator)) { throw 'Administrator privileges are required.' }
    [void](Assert-ProductionNetwork)
    $stageName = 'MySQL Preflight'
    $service = Get-Service -Name $MySqlServiceName -ErrorAction SilentlyContinue
    if (-not $service) { throw 'MySQL Server is missing. Manual installation is required.' }
    if ($service.Status -ne 'Running') { Start-Service -Name $service.Name; $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30)) }
    $preflightText = & $nodeExecutable (Join-Path $package.Root 'db\operations\preflight.mjs') --config $adminSource
    if ($LASTEXITCODE -ne 0) { throw 'MySQL preflight failed.' }
    $preflight = ($preflightText -join "`n") | ConvertFrom-Json
    if ($preflight.database[0].value -ne 'g2') { throw 'The database must be g2.' }
    if ($preflight.bindAddress[0].Value -notin @('127.0.0.1','localhost','::1')) { throw 'MySQL must listen only on localhost.' }
    if (@($preflight.mysqlxBindAddress).Count -and $preflight.mysqlxBindAddress[0].Value -notin @('127.0.0.1','localhost','::1')) { throw 'MySQL X Protocol must listen only on localhost.' }
    $stageName = 'Database Backup'
    $backupText = & $nodeExecutable (Join-Path $package.Root 'db\operations\backup.mjs') --config $adminSource --output $Config.backupPath --label pre-reinstall
    if ($LASTEXITCODE -ne 0) { throw 'Pre-reinstall backup failed; application was not stopped or replaced.' }
    $backup = ($backupText -join "`n" | ConvertFrom-Json).path
    Ensure-Directories
    Acquire-MaintenanceLock 'install-or-repair'; $lockAcquired = $true
    if (Test-Path -LiteralPath $installedConfig) {$originalConfig = [IO.File]::ReadAllBytes($installedConfig)}
    $stageName = 'Stop Host'
    Stop-Wdwelt -Maintenance; $stopped = $true
    $stageName = 'Package Validation'
    $package = Validate-Package $packageInput
    $snapshot = Join-Path $Config.runPath ('deployment-' + [guid]::NewGuid().ToString('n'))
    [IO.Directory]::CreateDirectory($snapshot) | Out-Null
    $stageName = 'Application Replacement'
    foreach ($item in @(@('production','current'),@('host','tools\host'),@('db','db'))) {
      $target = Join-Path $InstallPath $item[1]
      $saved = Join-Path $snapshot $item[0]
      if (-not (Test-PathWithin $target $InstallPath) -or -not (Test-PathWithin $saved $snapshot)) { throw 'Unsafe release path.' }
      $hadPrevious = Test-Path -LiteralPath $target
      if ($hadPrevious) { Move-Item -LiteralPath $target -Destination $saved }
      $activated.Add([pscustomobject]@{Target=$target;Saved=$saved;HadPrevious=$hadPrevious})
      [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
      Copy-Item -LiteralPath (Join-Path $package.Root $item[0]) -Destination $target -Recurse
    }
    [IO.Directory]::CreateDirectory((Join-Path $InstallPath 'config')) | Out-Null
    if (-not $adminSource.Equals($installedAdmin,[StringComparison]::OrdinalIgnoreCase)) {Copy-ProtectedCredential $adminSource $installedAdmin}
    if ($runtimeSource -and (Test-Path -LiteralPath $runtimeSource) -and -not $runtimeSource.Equals($installedRuntime,[StringComparison]::OrdinalIgnoreCase)) {Copy-ProtectedCredential $runtimeSource $installedRuntime}
    $stageName = 'Migration'
    $databaseResult = 'FORWARD MIGRATION ATTEMPTED; NOT RESTORED'
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\migrate.mjs') --config $installedAdmin --migrations (Join-Path $InstallPath 'db\migrations')
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    $stageName = 'Runtime Account'
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\repair-runtime.mjs') --admin-config $installedAdmin --runtime-config $installedRuntime
    if ($LASTEXITCODE -ne 0) { throw 'Runtime account repair failed.' }
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\runtime-check.mjs') --config $installedRuntime --require-schema
    if ($LASTEXITCODE -ne 0) { throw 'Runtime schema or permissions failed.' }
    $stageName = 'Recovery Configuration'
    $recoveryArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $package.Root 'tools\recovery.ps1'),'-Mode','initialize','-ConfigPath',$installedAdmin,'-NodePath',$nodeExecutable)
    if ($NonInteractive) {$recoveryArgs += '-NonInteractive'}
    & powershell.exe @recoveryArgs
    if ($LASTEXITCODE -ne 0) { throw 'Recovery configuration missing or initialization failed.' }
    $settings = @{port=8080;bindAddress=$chosen;canonicalHost=$chosen;canonicalUrl="http://${chosen}:8080";networkPolicy='deployment-settings-v1';deploymentEnvironmentName=$DeploymentEnvironmentName;networkSubnet=$ProductionSubnet;networkPrefixLength=$ProductionPrefixLength;networkGateway=$ProductionGateway;allowedRemoteAddresses=$remote;installPath=$InstallPath;currentPath=(Join-Path $InstallPath 'current');logPath=$Config.logPath;runPath=$Config.runPath;backupPath=$Config.backupPath;databaseConfigPath=$installedRuntime;adminDatabaseConfigPath=$installedAdmin;mysqlServiceName=$MySqlServiceName;nodePath=$nodeExecutable;healthIntervalSeconds=60;healthTimeoutSeconds=5;healthFailureThreshold=3;recoveryCooldownSeconds=120;maintenanceLockMinutes=15;logRetentionDays=14;logMaxBytes=5000000}
    $settings | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $installedConfig
    $script:Config = Read-WdweltConfig
    foreach ($toolName in @('wdwelt.ps1','deployment.ps1','recovery.ps1','deployment.json','database\backup.ps1','database\restore.ps1')) {
      $toolTarget = Join-Path $InstallPath "tools\$toolName"
      $originalTools[$toolTarget] = if (Test-Path -LiteralPath $toolTarget) {[IO.File]::ReadAllBytes($toolTarget)} else {$null}
      Copy-FileAtomically (Join-Path $package.Root "tools\$toolName") $toolTarget
    }
    $stageName = 'Scheduled Tasks'; Install-Tasks
    $stageName = 'Firewall'; Install-Firewall
    $stageName = 'Host Health'; Start-Wdwelt
    $live = Invoke-LiveHealth; $ready = Invoke-ReadyHealth
    if (-not $live -or -not $ready -or $ready.build -ne $package.Release.build) {throw 'Host live/ready verification failed.'}
    $stageName = 'Runtime Connection Verification'
    & $nodeExecutable (Join-Path $InstallPath 'db\operations\runtime-check.mjs') --config $installedRuntime --require-schema
    if ($LASTEXITCODE -ne 0) {throw 'Runtime database verification failed after host startup.'}
    $stageName = 'Recovery Availability'
    $availability = Invoke-RestMethod -Uri "http://${chosen}:8080/api/auth/recovery/status" -TimeoutSec 5
    if ($availability.available -ne $true) {throw 'Recovery availability verification failed.'}
    $stageName = 'LAN Verification'; Test-Network
    Write-Host "`nWDWELT DEPLOYMENT SUCCESS`nApplication: $($package.Release.version)`nDatabase: Ready`nMigration: Ready`nRuntime account: Ready`nRecovery: Ready`nHost: Ready`nLAN: ${chosen}:8080`n`nBackup:`n$backup`n`nNext:`nOpen http://${chosen}:8080 from a client device."
  } catch {
    $reason = $_.Exception.Message
    if ($stopped) {
      $rollbackResult = 'UNAVAILABLE (no verified previous application)'
      try {
        if (Get-VerifiedHost) {Stop-Wdwelt -Maintenance}
        for ($i=$activated.Count-1; $i -ge 0; $i--) {
          $item = $activated[$i]
          if (-not (Test-PathWithin $item.Target $InstallPath)) {throw 'Unsafe rollback path.'}
          if (Test-Path -LiteralPath $item.Target) {Remove-Item -LiteralPath $item.Target -Recurse -Force}
          if ($item.HadPrevious) {Move-Item -LiteralPath $item.Saved -Destination $item.Target}
        }
        if ($originalConfig) {[IO.File]::WriteAllBytes($installedConfig,$originalConfig); $script:Config = Read-WdweltConfig}
        elseif ($activated.Count -gt 0 -and (Test-Path -LiteralPath $installedConfig)) {Remove-Item -LiteralPath $installedConfig -Force}
        foreach ($toolTarget in $originalTools.Keys) {
          if ($null -ne $originalTools[$toolTarget]) {[IO.File]::WriteAllBytes($toolTarget,$originalTools[$toolTarget])}
          elseif (Test-Path -LiteralPath $toolTarget) {Remove-Item -LiteralPath $toolTarget -Force}
        }
        if ($originalConfig -and (Test-Path -LiteralPath (Join-Path $InstallPath 'tools\host\server.mjs'))) {
          Start-Wdwelt
          if (-not (Invoke-LiveHealth) -or -not (Invoke-ReadyHealth)) {throw 'Previous application health verification failed.'}
          $rollbackResult = 'SUCCESS'
        }
      } catch {$rollbackResult = 'FAILED; saved release retained at ' + $snapshot}
    }
    Write-Host "`nWDWELT DEPLOYMENT FAILED`nStage:`n$stageName`nReason:`n$reason`nApplication rollback:`n$rollbackResult`nDatabase:`n$databaseResult"
    throw 'Deployment did not complete. See the stage report above.'
  } finally {
    if ($lockAcquired) {Release-MaintenanceLock}
  }
}
