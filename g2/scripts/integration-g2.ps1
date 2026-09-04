$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TestRoot=Join-Path ([IO.Path]::GetTempPath()) ("wdwelt integration "+[guid]::NewGuid().ToString('n'))
$Tool=Join-Path $TestRoot 'tools\wdwelt.ps1'
$ConfigPath=Join-Path $TestRoot 'config\wdwelt.json'
$PackageRoot=Join-Path $TestRoot 'packages'
$checks=[Collections.Generic.List[string]]::new()
$UnknownProcess=$null

function Assert-True([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$checks.Add($Message)}
function Invoke-Tool([string]$Command,[switch]$ExpectFailure){
  & $Tool $Command -ConfigPath $ConfigPath @args
  $code=$LASTEXITCODE
  if($ExpectFailure){Assert-True ($code-ne0) "$Command safely failed"}else{Assert-True ($code-eq0) "$Command succeeded"}
}
function Write-Manifest([string]$Root,[string]$Version,[string]$Build){
  $files=@(Get-ChildItem (Join-Path $Root 'production'),(Join-Path $Root 'host'),(Join-Path $Root 'tools'),(Join-Path $Root 'db') -File -Recurse|%{@{path=$_.FullName.Substring($Root.Length+1).Replace('\','/');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
  @{formatVersion=2;version=$Version;build=$Build;createdAt=[DateTimeOffset]::UtcNow.ToString('o');productionDirectory='production';hostDirectory='host';toolsDirectory='tools';databaseDirectory='db';files=$files}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $Root 'manifest.json')
}
function New-Package([string]$Name,[string]$Version,[string]$Build,[switch]$BrokenHost){
  $root=Join-Path $PackageRoot $Name;New-Item $root\production,$root\host,$root\tools\database,$root\db -ItemType Directory -Force|Out-Null
  Copy-Item (Join-Path $ProjectRoot 'dist\*') $root\production -Recurse
  Copy-Item (Join-Path $ProjectRoot 'g2\host\*') $root\host -Recurse
  foreach($databaseFile in @('backup.mjs','bootstrap.mjs','config.mjs','migrate.mjs','mysql-driver.mjs','mysql-option-file.mjs','password.mjs','preflight.mjs','restore.mjs','runtime-check.mjs')){Copy-Item -LiteralPath (Join-Path $ProjectRoot "db\$databaseFile") -Destination (Join-Path $root "db\$databaseFile")}
  Copy-Item -LiteralPath (Join-Path $ProjectRoot 'db\migrations') -Destination (Join-Path $root 'db\migrations') -Recurse
  Copy-Item (Join-Path $ProjectRoot 'g2\scripts\backup.ps1') $root\tools\database\backup.ps1
  Copy-Item (Join-Path $ProjectRoot 'g2\scripts\restore.ps1') $root\tools\database\restore.ps1
  Copy-Item (Join-Path $ProjectRoot 'wdwelt.ps1') $root\tools\wdwelt.ps1
  & (Get-Command node).Source (Join-Path $ProjectRoot 'g2\scripts\copy-production-dependencies.mjs') $ProjectRoot $root\host\node_modules | Out-Host
  if($LASTEXITCODE-ne0){throw 'Could not stage production dependencies.'}
  $metadata=Get-Content -Raw -Encoding UTF8 $root\production\build-metadata.json|ConvertFrom-Json;$metadata.version=$Version;$metadata.build=$Build;$metadata|ConvertTo-Json|Set-Content -Encoding UTF8 $root\production\build-metadata.json
  if($BrokenHost){Set-Content -Encoding UTF8 $root\host\server.mjs 'process.exit(23);'}
  Write-Manifest $root $Version $Build
  return $root
}

try{
  $occupied=netstat -ano -p TCP|Select-String '^\s*TCP\s+\S+:8080\s+\S+\s+LISTENING'
  if($occupied){throw 'Port 8080 is already occupied; lifecycle test did not touch its owner.'}
  foreach($dir in @('current','previous','config','logs','run','backups','tools\host','db','packages')){New-Item (Join-Path $TestRoot $dir) -ItemType Directory -Force|Out-Null}
  Copy-Item (Join-Path $ProjectRoot 'dist\*') (Join-Path $TestRoot 'current') -Recurse
  Copy-Item (Join-Path $ProjectRoot 'g2\host\*') (Join-Path $TestRoot 'tools\host') -Recurse
  Copy-Item (Join-Path $ProjectRoot 'db\*') (Join-Path $TestRoot 'db') -Recurse
  Set-Content -Encoding UTF8 -LiteralPath (Join-Path $TestRoot 'db\legacy-marker.txt') -Value 'legacy database tools'
  & (Get-Command node).Source (Join-Path $ProjectRoot 'g2\scripts\copy-production-dependencies.mjs') $ProjectRoot (Join-Path $TestRoot 'tools\host\node_modules')
  if($LASTEXITCODE-ne0){throw 'Could not stage host production dependencies.'}
  Copy-Item (Join-Path $ProjectRoot 'wdwelt.ps1') $Tool
  $config=@{port=8080;bindAddress='127.0.0.1';canonicalHost='127.0.0.1';canonicalUrl='http://127.0.0.1:8080';installPath='..';currentPath='..\current';logPath='..\logs';runPath='..\run';nodePath=(Get-Command node).Source;healthIntervalSeconds=1;healthTimeoutSeconds=2;healthFailureThreshold=2;recoveryCooldownSeconds=30;maintenanceLockMinutes=1;logRetentionDays=2;logMaxBytes=100000}
  $config|ConvertTo-Json|Set-Content -Encoding UTF8 $ConfigPath

  $unknownScript=Join-Path $TestRoot 'unknown-port-owner.mjs'
  Set-Content -Encoding UTF8 $unknownScript "import{createServer}from'node:http';createServer((q,s)=>s.end('not-wdwelt')).listen(8080,'127.0.0.1');setInterval(()=>{},10000);"
  $UnknownProcess=Start-Process -FilePath $config.nodePath -ArgumentList ('"'+$unknownScript+'"') -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 500
  $unknownBlocked=$false
  try { & $Tool start -ConfigPath $ConfigPath } catch { $unknownBlocked=$true }
  Assert-True ($unknownBlocked -or $LASTEXITCODE -ne 0) 'unknown port owner blocked start'
  Assert-True (-not $UnknownProcess.HasExited) 'unknown port owner was not stopped'
  Stop-Process -Id $UnknownProcess.Id -Force;$UnknownProcess=$null
  Start-Sleep -Milliseconds 300

  Push-Location $env:SystemRoot
  try{Invoke-Tool start}finally{Pop-Location}
  Assert-True ((Test-Path -LiteralPath (Join-Path $TestRoot 'backups')) -and $true) 'legacy config without backupPath received a safe install-local default'
  Assert-True ((Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).root-eq(Join-Path $TestRoot 'current')) 'relative config paths resolved from config directory under another working directory'
  $firstPid=(Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid
  Invoke-Tool start
  $secondPid=(Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid
  Assert-True ($firstPid-eq$secondPid) 'duplicate start kept one PID'
  Invoke-Tool restart
  Assert-True ((Invoke-RestMethod http://127.0.0.1:8080/health/live).status-eq'ok') 'restart restored liveness'
  $dbDownPid=(Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid
  Invoke-Tool watchdog
  Assert-True ((Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid-eq$dbDownPid) 'watchdog did not restart a live Node process while database readiness was unavailable'
  Invoke-Tool stop
  Invoke-Tool watchdog
  Assert-True (-not(Test-Path $TestRoot\run\host.pid.json)) 'manual stop blocked watchdog restart'

  Remove-Item $TestRoot\run\manual-stop.json -Force
  @{owner='active-test';expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString('o')}|ConvertTo-Json|Set-Content -Encoding UTF8 $TestRoot\run\maintenance-lock.json
  Invoke-Tool watchdog
  $lockHealth=try{Invoke-RestMethod http://127.0.0.1:8080/health}catch{$null}
  Assert-True (-not $lockHealth) 'active maintenance lock blocked watchdog'
  Remove-Item $TestRoot\run\maintenance-lock.json -Force
  @{pid=999999;version='stale';build='stale';controlToken='stale'}|ConvertTo-Json|Set-Content -Encoding UTF8 $TestRoot\run\host.pid.json
  Invoke-Tool watchdog
  $firstHealth=try{Invoke-RestMethod http://127.0.0.1:8080/health}catch{$null}
  Assert-True (-not $firstHealth) 'first watchdog failure stayed below threshold'
  @{count=1;lastRecovery=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -Encoding UTF8 $TestRoot\run\health-failures.json
  Invoke-Tool watchdog
  $cooldownHealth=try{Invoke-RestMethod http://127.0.0.1:8080/health}catch{$null}
  Assert-True (-not $cooldownHealth) 'watchdog cooldown blocked immediate recovery'
  @{count=2;lastRecovery=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o')}|ConvertTo-Json|Set-Content -Encoding UTF8 $TestRoot\run\health-failures.json
  @{owner='stale';expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')}|ConvertTo-Json|Set-Content -Encoding UTF8 $TestRoot\run\maintenance-lock.json
  Invoke-Tool watchdog
  Assert-True ((Invoke-RestMethod http://127.0.0.1:8080/health/live).status -eq 'ok' -and -not (Test-Path $TestRoot\run\maintenance-lock.json)) 'threshold recovery handled stale PID and expired lock after cooldown'
  $healthyPid=(Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid
  Invoke-Tool daily
  Assert-True ((Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid -eq $healthyPid) '07:00 fallback kept healthy process'
  $noPreviousFailed=$false
  try{& $Tool rollback -ConfigPath $ConfigPath}catch{$noPreviousFailed=$true}
  Assert-True ($noPreviousFailed-or$LASTEXITCODE-ne0) 'rollback without previous failed safely'
  Assert-True ((Invoke-RestMethod http://127.0.0.1:8080/health/live).version-eq'0.3.0') 'rollback without previous did not stop current host'

  $success=New-Package 'success' '0.2.1' 'integration-success'
  $fakeRuntime=Join-Path $TestRoot 'runtime-db.json';$fakeAdmin=Join-Path $TestRoot 'admin-db.json';'{"host":"127.0.0.1","database":"g2","user":"test","password":"test"}'|Set-Content -Encoding UTF8 $fakeRuntime;Copy-Item $fakeRuntime $fakeAdmin
  $dryInstall=Join-Path $TestRoot 'dry run install target'
  Push-Location $env:SystemRoot
  try{& (Join-Path $success 'tools\wdwelt.ps1') install -InstallPath $dryInstall -CanonicalHost 127.0.0.1 -NodePath $config.nodePath -DatabaseConfigPath $fakeRuntime -AdminDatabaseConfigPath $fakeAdmin -DryRun;Assert-True ($LASTEXITCODE-eq0) 'packaged installer auto-detected package root from another working directory'}finally{Pop-Location}
  Assert-True (-not(Test-Path -LiteralPath $dryInstall)) 'installer dry-run made no filesystem changes'
  & (Join-Path $success 'tools\wdwelt.ps1') install -InstallPath $TestRoot -CanonicalHost 127.0.0.1 -NodePath $config.nodePath -DatabaseConfigPath $fakeRuntime -AdminDatabaseConfigPath $fakeAdmin -DryRun
  Assert-True ($LASTEXITCODE-eq0) 'repeat installer dry-run accepted the existing canonical origin'
  $originChangeFailed=$false
  try{& (Join-Path $success 'tools\wdwelt.ps1') install -InstallPath $TestRoot -CanonicalHost 192.0.2.10 -NodePath $config.nodePath -DatabaseConfigPath $fakeRuntime -AdminDatabaseConfigPath $fakeAdmin -DryRun}catch{$originChangeFailed=$true}
  Assert-True ($originChangeFailed-or$LASTEXITCODE-ne0) 'repeat installer rejected a canonical origin change'
  Assert-True ((Invoke-RestMethod http://127.0.0.1:8080/health/live).version-eq'0.3.0') 'repeat installer dry-runs did not replace the active release'
  $corrupt=Join-Path $PackageRoot 'corrupt';Copy-Item $success $corrupt -Recurse;Add-Content $corrupt\production\index.html '<!-- corrupt -->'
  $pidBeforeValidation=(Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid
  $validationFailed=$false
  try { & $Tool update -ConfigPath $ConfigPath -PackagePath $corrupt } catch { $validationFailed=$true }
  Assert-True ($validationFailed -or $LASTEXITCODE-ne0) 'corrupt package failed before activation'
  Assert-True ((Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid -eq $pidBeforeValidation) 'package validation failure did not stop current host'
  $traversal=Join-Path $PackageRoot 'traversal';Copy-Item $success $traversal -Recurse
  $traversalManifest=Get-Content -Raw -Encoding UTF8 $traversal\manifest.json|ConvertFrom-Json;$traversalManifest.files[0].path='../outside.txt';$traversalManifest|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 $traversal\manifest.json
  $traversalFailed=$false
  try{& $Tool update -ConfigPath $ConfigPath -PackagePath $traversal}catch{$traversalFailed=$true}
  Assert-True ($traversalFailed-or$LASTEXITCODE-ne0) 'manifest traversal path failed before activation'
  Assert-True ((Get-Content -Raw $TestRoot\run\host.pid.json|ConvertFrom-Json).pid-eq$pidBeforeValidation) 'manifest traversal rejection kept current host running'
  & $Tool update -ConfigPath $ConfigPath -PackagePath $success;Assert-True ($LASTEXITCODE-eq0) 'update succeeded'
  Assert-True (-not(Test-Path $TestRoot\db\legacy-marker.txt)-and(Test-Path $TestRoot\run\previous-db\legacy-marker.txt)) 'update switched database tools with the release'
  $health=Invoke-RestMethod http://127.0.0.1:8080/health/live;Assert-True ($health.version-eq'0.2.1'-and$health.build-eq'integration-success') 'update verified expected version and build'
  Set-Content -Encoding UTF8 $TestRoot\run\previous-host\server.mjs 'process.exit(29);'
  $failedRollback=$false
  try{& $Tool rollback -ConfigPath $ConfigPath}catch{$failedRollback=$true}
  Assert-True ($failedRollback-or$LASTEXITCODE-ne0) 'broken previous host made rollback fail'
  $health=Invoke-RestMethod http://127.0.0.1:8080/health/live;Assert-True ($health.version-eq'0.2.1'-and$health.build-eq'integration-success') 'failed manual rollback restored original healthy release'
  Remove-Item $TestRoot\run\previous-host -Recurse -Force;Copy-Item (Join-Path $ProjectRoot 'g2\host') $TestRoot\run\previous-host -Recurse
  & (Get-Command node).Source (Join-Path $ProjectRoot 'g2\scripts\copy-production-dependencies.mjs') $ProjectRoot (Join-Path $TestRoot 'run\previous-host\node_modules') | Out-Host
  if($LASTEXITCODE-ne0){throw 'Could not restore previous host dependencies.'}
  Invoke-Tool rollback
  Assert-True (Test-Path $TestRoot\db\legacy-marker.txt) 'manual rollback restored matching database tools'
  $health=Invoke-RestMethod http://127.0.0.1:8080/health/live;Assert-True ($health.version-eq'0.3.0') 'manual rollback restored previous release'

  & $Tool update -ConfigPath $ConfigPath -PackagePath $success;Assert-True ($LASTEXITCODE-eq0) 'second update succeeded'
  $broken=New-Package 'broken' '0.2.2' 'integration-broken' -BrokenHost
  $brokenFailed=$false
  try { & $Tool update -ConfigPath $ConfigPath -PackagePath $broken } catch { $brokenFailed=$true }
  Assert-True ($brokenFailed -or $LASTEXITCODE-ne0) 'broken update failed'
  $health=Invoke-RestMethod http://127.0.0.1:8080/health/live;Assert-True ($health.version-eq'0.2.1'-and$health.build-eq'integration-success') 'failed update restored previous healthy release'
  Assert-True ((Get-Content -Raw $TestRoot\previous\build-metadata.json|ConvertFrom-Json).version-eq'0.3.0') 'failed update preserved the older rollback slot'

  & $Tool stop -ConfigPath $ConfigPath|Out-Null
  Write-Host ("G2 lifecycle integration passed: {0} checks" -f $checks.Count)
  $checks|%{Write-Host "  PASS $_"}
  exit 0
}catch{
  Write-Error $_.Exception.Message
  exit 1
}finally{
  if($UnknownProcess -and -not $UnknownProcess.HasExited){Stop-Process -Id $UnknownProcess.Id -Force -ErrorAction SilentlyContinue}
  try{& $Tool stop -ConfigPath $ConfigPath|Out-Null}catch{}
  if(Test-Path $TestRoot){Remove-Item $TestRoot -Recurse -Force -ErrorAction SilentlyContinue}
}
