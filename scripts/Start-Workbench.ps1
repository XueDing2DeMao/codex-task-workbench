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
. (Join-Path $PSScriptRoot 'Workbench-Runtime.ps1')
. (Join-Path $PSScriptRoot 'Workbench-Setup.ps1')
function Read-Workbench {
  try { return Invoke-RestMethod -Uri "$appUrl/api/bootstrap" -TimeoutSec 2 }
  catch { return $null }
}
$cacheDir = Join-Path $projectDir '.runtime'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$startupLock = $null
$previousPath = $env:PATH
try {
  # 连续双击只进行一次安装/构建，第二个入口等待第一个准备完成。
  for ($attempt = 0; $attempt -lt 2400; $attempt++) {
    try {
      $startupLock = [IO.File]::Open((Join-Path $cacheDir 'startup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      break
    } catch [IO.IOException] {
      if ($attempt -eq 0) { Write-Host '任务空间正在另一个窗口中准备，请稍候…' }
      Start-Sleep -Milliseconds 250
    }
  }
  if ($null -eq $startupLock) { throw '另一个启动窗口仍在准备中，请稍后再次双击。' }
  $running = Read-Workbench
  if ($null -ne $running) {
    if ($running.application -ne 'codex-task-workbench' -or [IO.Path]::GetFullPath($running.dataDirectory) -ne $dataPath) {
      throw "端口 $Port 已被其他服务或任务空间占用，请先关闭对应服务后重试。"
    }
  } else {
    Write-Host '正在检查任务空间运行环境…'
    $node = Get-WorkbenchNode -RuntimeRoot (Join-Path $cacheDir 'node')
    $env:PATH = (Split-Path -Parent $node.Path) + [IO.Path]::PathSeparator + $previousPath
    Initialize-WorkbenchAssets -ProjectDir $projectDir -Node $node
    Write-Host '正在启动任务空间，将自动读取本机 Codex 项目与对话…'
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    $serverFile = Join-Path $projectDir 'server/index.ts'
    $nodeArgs = @('"' + $serverFile + '"', '--data-dir', '"' + $dataPath + '"', '--port', [string]$Port)
    foreach ($importRoot in $AllowRoot) { $nodeArgs += @('--allow-root', '"' + [IO.Path]::GetFullPath($importRoot) + '"') }
    $child = Start-Process -FilePath $node.Path -ArgumentList $nodeArgs -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath "server-$Port.log") -RedirectStandardError (Join-Path $dataPath "server-$Port.error.log")
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 250
      $running = Read-Workbench
      if ($null -ne $running) { break }
      if ($child.HasExited) { throw "服务启动失败，请查看 $dataPath\server-$Port.error.log，修复后重新双击启动。" }
    }
    if ($null -eq $running -or $running.application -ne 'codex-task-workbench' -or [IO.Path]::GetFullPath($running.dataDirectory) -ne $dataPath) {
      throw "服务尚未就绪，请查看 $dataPath\server-$Port.error.log。"
    }
  }
} finally {
  $env:PATH = $previousPath
  if ($null -ne $startupLock) { $startupLock.Dispose() }
}
Write-Host "任务空间已启动：$appUrl"
if (-not $NoBrowser) { Start-Process $appUrl }
