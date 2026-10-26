function Get-WorkbenchNodeInfo {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $npmCli = Join-Path (Split-Path -Parent $Path) 'node_modules/npm/bin/npm-cli.js'
  if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { return $null }
  try {
    $output = & $Path -p 'JSON.stringify({version:process.versions.node,architecture:process.arch})' 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $info = $output | ConvertFrom-Json
    $version = [version]$info.version
    if ($version -lt [version]'24.13.0' -or $version -ge [version]'25.0.0') { return $null }
    if ($info.architecture -notin @('x64', 'arm64')) { return $null }
    return [pscustomobject]@{ Path = [IO.Path]::GetFullPath($Path); NpmCli = $npmCli; Version = $info.version; Architecture = $info.architecture }
  } catch { return $null }
}

function Get-WorkbenchRuntimeArchitecture {
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  switch ($architecture) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { throw '当前 Windows 架构不支持自动准备运行环境；需要 64 位 Windows（x64 或 ARM64）。' }
  }
}

function Remove-WorkbenchRuntimeDirectory {
  param([string]$Path, [string]$RuntimeRoot)
  $rootPrefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '运行环境清理路径超出项目专用目录，已停止。' }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

function Get-WorkbenchNode {
  param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
  $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($command) {
    $installed = Get-WorkbenchNodeInfo -Path $command.Source
    if ($installed) { return $installed }
  }

  $architecture = Get-WorkbenchRuntimeArchitecture
  $runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
  $folderName = "node-v24.13.0-win-$architecture"
  $destination = Join-Path $runtimePath $folderName
  $cached = Get-WorkbenchNodeInfo -Path (Join-Path $destination 'node.exe')
  if ($cached -and $cached.Version -eq '24.13.0' -and $cached.Architecture -eq $architecture) { return $cached }

  # 固定官方发行包及其 SHA-256；完整校验通过后才解压和执行。
  $checksums = @{
    x64 = 'ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88'
    arm64 = '92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a'
  }
  $staging = Join-Path $runtimePath ('.download-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  $archive = Join-Path $staging "$folderName.zip"
  $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
  $previousProgress = $ProgressPreference
  try {
    Write-Host '正在准备项目专用运行环境，首次启动需要联网下载，请稍候…'
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/download/release/v24.13.0/$folderName.zip" -OutFile $archive -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksums[$architecture]) {
      throw '运行环境下载文件校验失败，未执行下载内容。请检查网络后重新双击启动。'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
    $extracted = [IO.Path]::GetFullPath((Join-Path $staging $folderName))
    $prepared = Get-WorkbenchNodeInfo -Path (Join-Path $extracted 'node.exe')
    if (-not $prepared -or $prepared.Version -ne '24.13.0' -or $prepared.Architecture -ne $architecture) {
      throw '下载的运行环境无法正常启动。请重新双击启动，或检查安全软件的拦截提示。'
    }
    # 仅替换本助手管理的固定版本目录，下载失败时保留旧缓存。
    $rootPrefix = $runtimePath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $extracted.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFullPath($destination)).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw '运行环境安装路径超出项目专用目录，已停止。'
    }
    Remove-WorkbenchRuntimeDirectory -Path $destination -RuntimeRoot $runtimePath
    Move-Item -LiteralPath $extracted -Destination $destination
    $ready = Get-WorkbenchNodeInfo -Path (Join-Path $destination 'node.exe')
    if (-not $ready) { throw '项目运行环境准备不完整，请重新双击启动。' }
    return $ready
  } catch {
    throw "无法准备项目专用运行环境：$($_.Exception.Message)"
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    $ProgressPreference = $previousProgress
    Remove-WorkbenchRuntimeDirectory -Path $staging -RuntimeRoot $runtimePath
  }
}
