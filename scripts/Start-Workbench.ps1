param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexTaskWorkbench'),
  [ValidateRange(1024, 65535)][int]$Port = 43127,
  [string[]]$AllowRoot = @(),
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$dataPath = [IO.Path]::GetFullPath($DataDir)
$appUrl = "http://127.0.0.1:$Port"
if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'dist/index.html'))) {
  throw 'Build missing. Run npm ci and npm run build in the project folder first.'
}
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ([version]$nodeVersion -lt [version]'24.13.0' -or [version]$nodeVersion -ge [version]'25.0.0') {
  throw "Requires Node.js 24.13 or later in the 24.x line. Found $nodeVersion"
}
function Read-Workbench {
  try { return Invoke-RestMethod -Uri "$appUrl/api/bootstrap" -TimeoutSec 2 }
  catch { return $null }
}
$running = Read-Workbench
if ($null -ne $running) {
  if ($running.application -ne 'codex-task-workbench' -or [IO.Path]::GetFullPath($running.dataDirectory) -ne $dataPath) {
    throw "Port $Port is in use by another service or data directory. Choose another -Port."
  }
} else {
  New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
  $serverFile = Join-Path $projectDir 'server/index.ts'
  $nodeArgs = @('"' + $serverFile + '"', '--data-dir', '"' + $dataPath + '"', '--port', [string]$Port)
  foreach ($importRoot in $AllowRoot) { $nodeArgs += @('--allow-root', '"' + [IO.Path]::GetFullPath($importRoot) + '"') }
  $child = Start-Process -FilePath $nodeCommand.Source -ArgumentList $nodeArgs -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath "server-$Port.log") -RedirectStandardError (Join-Path $dataPath "server-$Port.error.log")
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $running = Read-Workbench
    if ($null -ne $running) { break }
    if ($child.HasExited) { throw "Service exited. See $dataPath\server-$Port.error.log" }
  }
  if ($null -eq $running -or $running.application -ne 'codex-task-workbench' -or [IO.Path]::GetFullPath($running.dataDirectory) -ne $dataPath) {
    throw "Service did not start correctly. See $dataPath\server-$Port.error.log"
  }
}
Write-Output "Workbench: $appUrl"
Write-Output "Data: $dataPath"
if (-not $NoBrowser) { Start-Process $appUrl }
