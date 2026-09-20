[CmdletBinding()]
param(
  [ValidateSet('status','set','initialize')][string]$Mode = 'status',
  [string]$ConfigPath,
  [string]$NodePath,
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $root 'config\local\database.admin.json'
  if (-not (Test-Path -LiteralPath $ConfigPath)) { $ConfigPath = Join-Path $root 'config\database.admin.json' }
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$operation = Join-Path $root 'db\operations\recovery.mjs'
$node = if ($NodePath) {[IO.Path]::GetFullPath($NodePath)} else {(Get-Command node -ErrorAction Stop).Source}
try {
  if ($Mode -eq 'status') { & $node $operation status --config $ConfigPath; exit $LASTEXITCODE }
  if ($Mode -eq 'initialize') {
    $statusText = & $node $operation status --config $ConfigPath --json
    if ($LASTEXITCODE -ne 0) { throw 'Recovery database check failed.' }
    $status = ($statusText -join "`n") | ConvertFrom-Json
    if ($status.configured) {
      Write-Host 'Recovery configuration found.'
      Write-Host 'Existing Master Recovery Password preserved.'
      exit 0
    }
  }
  if ($NonInteractive) { throw 'Recovery configuration missing. Run installer interactively to initialize it.' }
  $first = Read-Host $(if ($Mode -eq 'initialize') {'Set Master Recovery Password'} else {'New Master Recovery Password'}) -AsSecureString
  $second = Read-Host 'Confirm Master Recovery Password' -AsSecureString
  $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
  $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
  try {
    $payload = @{password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer);confirmation=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer)} | ConvertTo-Json -Compress
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $node
    if ($operation.Contains('"') -or $ConfigPath.Contains('"')) { throw 'Invalid path.' }
    $info.Arguments = '"' + $operation + '" ' + $Mode + ' --stdin --config "' + $ConfigPath + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $child = [Diagnostics.Process]::Start($info)
    try {
      $secretBytes = [Text.Encoding]::UTF8.GetBytes($payload)
      $child.StandardInput.BaseStream.Write($secretBytes,0,$secretBytes.Length)
      $child.StandardInput.BaseStream.Flush()
      [Array]::Clear($secretBytes,0,$secretBytes.Length)
      $child.StandardInput.Close()
      $child.WaitForExit()
      if ($child.ExitCode -ne 0) { throw 'Recovery configuration failed.' }
    } finally { $child.Dispose() }
  } finally {
    $payload = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer)
    $first.Dispose(); $second.Dispose()
  }
  exit 0
} catch {
  Write-Host ('Recovery Configuration: ' + $_.Exception.Message)
  exit 1
}
