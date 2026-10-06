[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$artifacts=Join-Path $repository 'artifacts'
$package=Join-Path $artifacts 'wdwelt-package'
$kit=Join-Path $artifacts 'wdwelt-target-kit'
$zip=Join-Path $artifacts 'WDWELT-TARGET.zip'
$verification=Join-Path $artifacts 'target-kit-verify'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$npmCli=Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if(-not(Test-Path -LiteralPath $npmCli -PathType Leaf)){throw '找不到 npm-cli.js。'}
Set-Location -LiteralPath $repository

function Assert-FileEquals([string]$Source,[string]$Target,[string]$Label){
  if(-not(Test-Path -LiteralPath $Source -PathType Leaf)){throw "$Label source missing: $Source"}
  if(-not(Test-Path -LiteralPath $Target -PathType Leaf)){throw "$Label target missing: $Target"}
  $sourceHash=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
  $targetHash=(Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
  if($sourceHash-ne$targetHash){throw "$Label differs from source: $Target"}
}

function Assert-DirectoryMirror([string]$Source,[string]$Target,[string]$Label,[string]$AllowExtraPrefix=''){
  if(-not(Test-Path -LiteralPath $Source -PathType Container)-or-not(Test-Path -LiteralPath $Target -PathType Container)){throw "$Label directory missing."}
  $sourceFiles=@(Get-ChildItem -LiteralPath $Source -File -Recurse)
  $targetFiles=@(Get-ChildItem -LiteralPath $Target -File -Recurse|Where-Object{
    $relative=$_.FullName.Substring($Target.Length+1).Replace('\','/')
    -not($AllowExtraPrefix-and$relative.StartsWith($AllowExtraPrefix,[StringComparison]::OrdinalIgnoreCase))
  })
  $targetMap=@{}
  foreach($file in $targetFiles){$targetMap[$file.FullName.Substring($Target.Length+1).Replace('\','/')]=$file.FullName}
  if($sourceFiles.Count-ne$targetFiles.Count){throw "$Label file count differs from source ($($sourceFiles.Count) source, $($targetFiles.Count) target)."}
  foreach($file in $sourceFiles){
    $relative=$file.FullName.Substring($Source.Length+1).Replace('\','/')
    if(-not$targetMap.ContainsKey($relative)){throw "$Label missing copied file: $relative"}
    Assert-FileEquals $file.FullName $targetMap[$relative] "$Label/$relative"
  }
}

function Assert-PowerShellSyntax([string]$Path){
  $tokens=$null;$parseErrors=$null
  [void][Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$parseErrors)
  if(@($parseErrors).Count){throw "Malformed PowerShell artifact: $Path`n$((@($parseErrors)|ForEach-Object Message)-join[Environment]::NewLine)"}
}

function Assert-Contains([string]$Text,[string]$Expected,[string]$Label){
  if(-not$Text.Contains($Expected)){throw "$Label missing required token: $Expected"}
}

function Assert-ManagerContract([string]$ManagerPath){
  Assert-PowerShellSyntax $ManagerPath
  $manager=Get-Content -Raw -LiteralPath $ManagerPath
  Assert-Contains $manager "Invoke-DatabaseTool 'backup.mjs' @('--config',[string]`$Config.adminDatabaseConfigPath" 'Administrative backup chain'
  Assert-Contains $manager '-RemoteAddress $remoteAddresses -Profile $firewallProfiles' 'Restricted firewall scope'
  Assert-Contains $manager "if(`$AllowPublicProfile){'Private','Domain','Public'}else{'Private','Domain'}" 'Public firewall profile'
  if($manager-match 'New-NetFirewallRule[^\r\n]+-RemoteAddress\s+LocalSubnet'){throw 'Packaged firewall rule unexpectedly permits LocalSubnet.'}
  $updateStart=$manager.IndexOf('function Invoke-Update',[StringComparison]::Ordinal)
  $updateEnd=$manager.IndexOf('function Switch-DirectoryPair',[StringComparison]::Ordinal)
  if($updateStart-lt0-or$updateEnd-le$updateStart){throw 'Packaged update function is missing or malformed.'}
  $update=$manager.Substring($updateStart,$updateEnd-$updateStart)
  $backup=$update.IndexOf("Invoke-DatabaseBackup 'pre-migration' `$package.Root",[StringComparison]::Ordinal)
  $lock=$update.IndexOf("Acquire-MaintenanceLock 'update'",[StringComparison]::Ordinal)
  $stop=$update.IndexOf('Stop-Wdwelt -Maintenance',[StringComparison]::Ordinal)
  $move=$update.IndexOf('Move-Item -LiteralPath $current -Destination $previous',[StringComparison]::Ordinal)
  if($backup-lt0-or$lock-lt0-or$stop-lt0-or$move-lt0-or-not($backup-lt$lock-and$backup-lt$stop-and$backup-lt$move)){throw 'Packaged update does not abort on backup failure before maintenance or release replacement.'}
}

function Assert-Manifest([string]$PackageRoot){
  $manifestPath=Join-Path $PackageRoot 'manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'Production package manifest is missing.'}
  $manifest=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
  if([int]$manifest.formatVersion-ne2){throw 'Production package manifest formatVersion is not 2.'}
  $declared=@{}
  foreach($entry in @($manifest.files)){
    $relative=[string]$entry.path
    if($declared.ContainsKey($relative)){throw "Duplicate manifest path: $relative"}
    $path=Join-Path $PackageRoot $relative.Replace('/',[IO.Path]::DirectorySeparatorChar)
    if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw "Manifest file missing: $relative"}
    $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash-ne([string]$entry.sha256).ToLowerInvariant()){throw "Manifest hash mismatch: $relative"}
    $declared[$relative]=$true
  }
  $actual=@(Get-ChildItem (Join-Path $PackageRoot 'production'),(Join-Path $PackageRoot 'host'),(Join-Path $PackageRoot 'tools'),(Join-Path $PackageRoot 'db') -File -Recurse)
  if($actual.Count-ne$declared.Count){throw "Manifest file count mismatch ($($declared.Count) declared, $($actual.Count) actual)."}
  foreach($file in $actual){
    $relative=$file.FullName.Substring($PackageRoot.Length+1).Replace('\','/')
    if(-not$declared.ContainsKey($relative)){throw "File absent from manifest: $relative"}
  }
}

function Assert-ProductionPackage([string]$PackageRoot){
  Assert-DirectoryMirror (Join-Path $repository 'dist') (Join-Path $PackageRoot 'production') 'production'
  Assert-DirectoryMirror (Join-Path $repository 'server\app') (Join-Path $PackageRoot 'host') 'host' 'node_modules/'
  foreach($directory in @('core','operations','migrations')){Assert-DirectoryMirror (Join-Path $repository "db\$directory") (Join-Path $PackageRoot "db\$directory") "db/$directory"}
  $copiedFiles=@(
    @('install\wdwelt.ps1','tools\wdwelt.ps1'),
    @('install\recovery.ps1','tools\recovery.ps1'),
    @('install\target-recovery.ps1','tools\target-recovery.ps1'),
    @('install\windows\backup.ps1','tools\database\backup.ps1'),
    @('install\windows\restore.ps1','tools\database\restore.ps1'),
    @('config\deployment.json','tools\deployment.json')
  )
  foreach($copy in $copiedFiles){Assert-FileEquals (Join-Path $repository $copy[0]) (Join-Path $PackageRoot $copy[1]) $copy[1]}
  foreach($script in Get-ChildItem -LiteralPath $PackageRoot -Filter *.ps1 -File -Recurse){Assert-PowerShellSyntax $script.FullName}
  Assert-ManagerContract (Join-Path $PackageRoot 'tools\wdwelt.ps1')
  $backup=Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'db\operations\backup.mjs')
  Assert-Contains $backup 'const config = loadDatabaseConfig(configPath);' 'Packaged backup config loading'
  Assert-Contains $backup 'const option = createOptionFile(config);' 'Packaged backup option file'
  Assert-Contains $backup 'spawn(config.mysqlDumpPath, args' 'Packaged mysqldump invocation'
  $targetDatabase=Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'db\operations\target-environment.mjs')
  Assert-Contains $targetDatabase "writeProtectedJson(resolve(directory,'database.admin.json'),{...common,user:'root'})" 'Administrative DB config'
  Assert-Contains $targetDatabase "writeProtectedJson(resolve(directory,'database.runtime.json'),{...common,user:'wdwelt_app'})" 'Runtime DB config'
  Assert-Manifest $PackageRoot
}

function Assert-SetupContract([string]$SetupPath){
  Assert-PowerShellSyntax $SetupPath
  $setup=Get-Content -Raw -LiteralPath $SetupPath
  Assert-Contains $setup "'tools\wdwelt.ps1'),'install'" 'Compact manager invocation'
  Assert-Contains $setup "'-DatabaseConfigPath',`$runtimeConfig,'-AdminDatabaseConfigPath',`$admin" 'Separate runtime/admin configs'
  Assert-Contains $setup "'-CanonicalHost','192.168.0.18','-AllowedRemoteAddress','192.168.0.0/22','-AllowPublicProfile'" 'Production firewall arguments'
  Assert-Contains $setup "'start','-ConfigPath',`$installedConfig" 'Installed host control path'
  if($setup-match 'npm\s+(?:ci|install|test)|run\s+build'){throw 'Compact target setup unexpectedly invokes a development npm pipeline.'}
}

function Assert-TargetKit([string]$KitRoot,[string]$PayloadRoot){
  $expected=@('package.json','payload.sha256','payload.zip','setup.ps1')
  $visible=@(Get-ChildItem -LiteralPath $KitRoot -Force)
  if($visible.Count-ne$expected.Count-or@($visible|Where-Object{$_.PSIsContainer-or$_.Name-notin$expected}).Count){throw "Target kit visible contents are not exactly: $($expected-join', ')"}
  $kitPackage=Get-Content -Raw -LiteralPath (Join-Path $KitRoot 'package.json')|ConvertFrom-Json
  if($kitPackage.scripts.setup-ne'powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1'){throw 'Target kit setup command is not the compact installer.'}
  if($kitPackage.scripts.host-ne'powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -StartOnly'){throw 'Target kit host command is not the installed-host control path.'}
  if($kitPackage.scripts.setup-match'bootstrap|install/bootstrap'-or$kitPackage.scripts.host-match'server/app|development.json'){throw 'Target kit command fell back to repository development/bootstrap behavior.'}
  Assert-FileEquals (Join-Path $repository 'install\compact-target-setup.ps1') (Join-Path $KitRoot 'setup.ps1') 'Compact setup'
  Assert-SetupContract (Join-Path $KitRoot 'setup.ps1')
  $expectedHash=(Get-Content -Raw -LiteralPath (Join-Path $KitRoot 'payload.sha256')).Trim().ToLowerInvariant()
  $actualHash=(Get-FileHash -LiteralPath (Join-Path $KitRoot 'payload.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
  if($expectedHash-ne$actualHash){throw 'Target kit payload SHA-256 mismatch.'}
  Assert-ProductionPackage $PayloadRoot
  return $actualHash
}

if(-not$SkipTests){& $node $npmCli test;if($LASTEXITCODE-ne0){throw 'Tests failed; target kit was not created.'}}
& $node $npmCli run build;if($LASTEXITCODE-ne0){throw 'Build failed; target kit was not created.'}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repository 'install\wdwelt.ps1') package -PackagePath $package
if($LASTEXITCODE-ne0){throw 'Production package failed; target kit was not created.'}
Assert-ProductionPackage $package

if(Test-Path -LiteralPath $kit){Remove-Item -LiteralPath $kit -Recurse -Force}
[IO.Directory]::CreateDirectory($kit)|Out-Null
$payloadZip=Join-Path $kit 'payload.zip'
Compress-Archive -Path (Join-Path $package '*') -DestinationPath $payloadZip -CompressionLevel Optimal
(Get-FileHash -LiteralPath $payloadZip -Algorithm SHA256).Hash.ToLowerInvariant()|Set-Content -LiteralPath (Join-Path $kit 'payload.sha256') -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $repository 'install\compact-target-setup.ps1') -Destination (Join-Path $kit 'setup.ps1')
$kitPackage=[ordered]@{
  name='wdwelt-target-kit';private=$true;version=(Get-Content -Raw -LiteralPath (Join-Path $repository 'package.json')|ConvertFrom-Json).version
  scripts=[ordered]@{
    setup='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1'
    host='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -StartOnly'
    diagnose='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -PlanOnly'
  }
}
[IO.File]::WriteAllText((Join-Path $kit 'package.json'),(($kitPackage|ConvertTo-Json -Depth 4)+"`n"),[Text.UTF8Encoding]::new($false))

if(Test-Path -LiteralPath $verification){Remove-Item -LiteralPath $verification -Recurse -Force}
$payloadVerification=Join-Path $verification 'payload'
[IO.Directory]::CreateDirectory($payloadVerification)|Out-Null
Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadVerification -Force
$payloadHash=Assert-TargetKit $kit $payloadVerification

if(Test-Path -LiteralPath $zip){Remove-Item -LiteralPath $zip -Force}
Compress-Archive -Path (Join-Path $kit '*') -DestinationPath $zip -CompressionLevel Optimal
$finalVerification=Join-Path $verification 'final-zip'
[IO.Directory]::CreateDirectory($finalVerification)|Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $finalVerification -Force
foreach($name in @('package.json','setup.ps1','payload.zip','payload.sha256')){Assert-FileEquals (Join-Path $kit $name) (Join-Path $finalVerification $name) "Final ZIP/$name"}
$finalPayload=Join-Path $verification 'final-payload'
[IO.Directory]::CreateDirectory($finalPayload)|Out-Null
Expand-Archive -LiteralPath (Join-Path $finalVerification 'payload.zip') -DestinationPath $finalPayload -Force
[void](Assert-TargetKit $finalVerification $finalPayload)

$files=@(Get-ChildItem -LiteralPath $kit -File)
Write-Host "Target kit created and verified: $zip"
Write-Host "Payload SHA-256: $payloadHash"
Write-Host "Visible files: $($files.Count); unpacked size: $([math]::Round((($files|Measure-Object Length -Sum).Sum)/1MB,2)) MiB; zip size: $([math]::Round((Get-Item $zip).Length/1MB,2)) MiB"
