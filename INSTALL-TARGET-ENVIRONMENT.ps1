[CmdletBinding()]
param([switch]$PlanOnly,[string]$MySqlServiceName='MySQL80')
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'install\target-environment.ps1') -PlanOnly:$PlanOnly -MySqlServiceName $MySqlServiceName
exit $LASTEXITCODE
