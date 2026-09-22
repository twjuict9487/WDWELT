param([string]$AdminConfig)
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$admin=if($AdminConfig){[IO.Path]::GetFullPath($AdminConfig)}else{Join-Path $repository 'config\local\database.admin.json'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$operation=Join-Path $repository 'db\operations\recovery.mjs'
$processInfo=New-Object Diagnostics.ProcessStartInfo
$processInfo.FileName=$node
$processInfo.Arguments='"'+$operation+'" set --stdin --config "'+$admin+'"'
$processInfo.UseShellExecute=$false
$processInfo.CreateNoWindow=$true
$processInfo.RedirectStandardInput=$true
$child=[Diagnostics.Process]::Start($processInfo)
try {
  $payload=[Text.Encoding]::UTF8.GetBytes('{"password":"11335248","confirmation":"11335248"}')
  $child.StandardInput.BaseStream.Write($payload,0,$payload.Length)
  [Array]::Clear($payload,0,$payload.Length)
  $child.StandardInput.Close()
  $child.WaitForExit()
  if($child.ExitCode-ne0){exit 1}
} finally {$child.Dispose()}
Write-Host 'Master recovery password set for target environment.'
