param([string]$RecoveryScript,[string]$ConfigPath)
$ErrorActionPreference='Stop'
# Supply secure inputs without a desktop or interactive console.
$values=[Console]::In.ReadToEnd() | ConvertFrom-Json
$global:fixtureAnswers=[Collections.Generic.Queue[string]]::new()
$global:fixtureAnswers.Enqueue($values.password)
$global:fixtureAnswers.Enqueue($values.confirmation)
function Read-Host {
  param([string]$Prompt,[switch]$AsSecureString)
  if (-not $AsSecureString) {throw 'Password prompt must use secure input.'}
  return (ConvertTo-SecureString -String $global:fixtureAnswers.Dequeue() -AsPlainText -Force)
}
& $RecoveryScript -Mode initialize -ConfigPath $ConfigPath

exit $LASTEXITCODE
