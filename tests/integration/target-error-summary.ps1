param([string]$TargetPath,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($TargetPath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Target installer parser errors'}
foreach($definition in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
  Invoke-Expression $definition.Extent.Text
}
$logRoot=$FixtureRoot
$logPath=Join-Path $FixtureRoot 'target-full.log'
$lastErrorPath=Join-Path $FixtureRoot 'LAST-ERROR.txt'
$stage='安裝鎖定的 JavaScript dependencies'
$MySqlServiceName='MySQL80'
@('initial output','npm ERR! registry unavailable')|Set-Content -LiteralPath $logPath -Encoding UTF8
try{throw 'npm dependency install failed'}catch{Write-FailureSummary $_}
$summary=Get-Content -Raw -Encoding UTF8 -LiteralPath $lastErrorPath
if($summary -notmatch '失敗階段：安裝鎖定的 JavaScript dependencies'){throw 'Missing failure stage'}
if($summary -notmatch 'npm dependency install failed'){throw 'Missing original reason'}
if($summary -notmatch 'ForceDependencies'){throw 'Missing actionable next step'}
if($summary -notmatch 'npm ERR! registry unavailable'){throw 'Missing log tail'}
