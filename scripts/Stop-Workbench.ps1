param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexTaskWorkbench'),
  [ValidateRange(1024, 65535)][int]$Port = 43127
)
$ErrorActionPreference = 'Stop'
$appUrl = "http://127.0.0.1:$Port"
$dataPath = [IO.Path]::GetFullPath($DataDir)
try { $runtime = Invoke-RestMethod -Uri "$appUrl/api/bootstrap" -SessionVariable workbenchSession -TimeoutSec 3 }
catch { Write-Output "No reachable workbench on port $Port."; exit 0 }
if ($runtime.application -ne 'codex-task-workbench' -or [IO.Path]::GetFullPath($runtime.dataDirectory) -ne $dataPath) {
  throw 'Service identity or data directory does not match. Nothing was stopped.'
}
Invoke-RestMethod -Uri "$appUrl/api/shutdown" -Method Post -WebSession $workbenchSession -Headers @{ 'X-Workbench-Token' = $runtime.csrfToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
Write-Output "Stopped workbench on port $Port. Saved data remains at $dataPath"
