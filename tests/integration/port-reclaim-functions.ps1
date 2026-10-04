param([string]$ManagerPath)
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ManagerPath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Manager parser errors'}
$definition=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-ConflictingPortOwner'},$false)|Select-Object -First 1
if(-not $definition){throw 'Stop-ConflictingPortOwner was not found'}
Invoke-Expression $definition.Extent.Text
$Config=[pscustomobject]@{reclaimPort8080=$true}
$ownerChecks=0
$stoppedPid=0
function Get-PortOwner {$script:ownerChecks++;if($script:ownerChecks -eq 1){return [pscustomobject]@{PID=4321;Name='node.exe'}};return $null}
function Get-VerifiedHost {return $null}
function Write-OperationLog {}
function Stop-Process {param([int]$Id,[switch]$Force,[object]$ErrorAction)$script:stoppedPid=$Id}
function Start-Sleep {}
function Get-Process {return $null}
$result=Stop-ConflictingPortOwner
if(-not $result){throw 'Port reclaim did not report success'}
if($stoppedPid -ne 4321){throw 'Stop-Process did not receive the conflicting PID'}
