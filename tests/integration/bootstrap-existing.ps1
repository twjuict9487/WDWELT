param([string]$BootstrapPath, [string]$FixtureRoot, [string]$Failure = '')
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($BootstrapPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Bootstrap parser errors' }
# Load actual bootstrap functions without executing its system-modifying entry point.
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
  Invoke-Expression $definition.Extent.Text
}
$RepositoryRoot = $FixtureRoot
$InstallDirectory = Join-Path $FixtureRoot 'install'
$LocalConfigRoot = Join-Path $FixtureRoot 'config\local'
$RuntimeRoot = Join-Path $FixtureRoot 'runtime'
$InstallPath = Join-Path $FixtureRoot 'installed'
$BootstrapLog = $null; $PhaseNumber = 0; $PhaseCount = 13
$ExistingAccounts = $true; $NonInteractive = $true; $PlanOnly = $false
$Offline = $false; $FullValidation = $false; $SkipTests = $false; $AllowPublicProfile = $false
$ProductionAllowedRemoteAddresses = @('10.20.30.0/24')
$trace = [Collections.Generic.List[string]]::new()
function Assert-RepositoryLayout {}
function Show-Plan {}
function Restart-ElevatedIfNeeded { return $false }
function Assert-ProductionNetwork { return '10.20.30.18' }
function Ensure-Node { return 'node.exe' }
function Get-NpmPath { return 'npm.cmd' }
function Ensure-MySqlService { return [pscustomobject]@{Service=[pscustomobject]@{Name='TestMySQL'};MySql='C:\MySQL\mysql.exe';MySqlDump='C:\MySQL\mysqldump.exe'} }
function Read-AdminConfig { throw 'Must not request root credentials' }
function Ensure-G2Database { throw 'Must not create an existing database' }
function Set-LocalhostBind { throw 'Must not edit existing MySQL settings' }
function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$Description) {
  $trace.Add($Description)
  if ($Arguments -contains 'db\operations\bootstrap.mjs') { throw 'Must not modify existing MySQL accounts' }
  if ($Description -eq 'npm ci' -and $Arguments -notcontains '--include=dev') { throw 'Build tools must be installed even with NODE_ENV=production' }
  if ($Description -eq $Failure) { throw 'Injected dependency/DB/build failure' }
}
$packageTool = Join-Path $FixtureRoot 'artifacts\wdwelt-package\tools\wdwelt.ps1'
[IO.Directory]::CreateDirectory($InstallDirectory) | Out-Null
[IO.Directory]::CreateDirectory($InstallPath) | Out-Null
[IO.File]::WriteAllText((Join-Path $InstallDirectory 'wdwelt.ps1'), '$global:LASTEXITCODE=0')
[IO.Directory]::CreateDirectory((Split-Path -Parent $packageTool)) | Out-Null
[IO.File]::WriteAllText($packageTool, @'
param([string]$Command,[string]$InstallPath,[string]$CanonicalHost,[string[]]$AllowedRemoteAddress,[string]$NodePath,[string]$MySqlServiceName,[string]$DatabaseConfigPath,[string]$AdminDatabaseConfigPath,[bool]$AllowPublicProfile,[string]$DeploymentSettingsPath,[switch]$DryRun)
if ($DryRun) {
  Add-Content -LiteralPath (Join-Path $InstallPath '..\installer-trace.txt') -Value 'dry-run'
  if ($env:WDWELT_TEST_DRYRUN_FAILURE -eq '1') { $global:LASTEXITCODE=9; return }
} else { Add-Content -LiteralPath (Join-Path $InstallPath '..\installer-trace.txt') -Value 'install' }
$global:LASTEXITCODE=0
'@)
$env:WDWELT_TEST_DRYRUN_FAILURE = if ($Failure -eq 'dry-run') { '1' } else { '0' }
try { Main }
finally { $trace | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $FixtureRoot 'trace.json') }
