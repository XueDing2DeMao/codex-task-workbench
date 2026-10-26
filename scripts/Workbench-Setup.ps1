function Get-WorkbenchFingerprint {
  param([string[]]$Values)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Values -join "`n"))))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}

function Invoke-WorkbenchTool {
  param($Node, [string]$EntryPoint, [string[]]$Arguments, [string]$Label)
  # Windows PowerShell 5.1 会把原生 stderr 包装成错误；以退出码判断 npm 是否失败。
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Node.Path $EntryPoint @Arguments 2>&1 | ForEach-Object { Write-Host "$_" }
    $npmExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorAction }
  if ($npmExitCode -ne 0) { throw "自动准备失败（$Label，退出码 $npmExitCode）。请检查网络和上方提示，然后重新双击启动。" }
}

function Initialize-WorkbenchAssets {
  param([Parameter(Mandatory)][string]$ProjectDir, [Parameter(Mandatory)]$Node)
  $manifestPath = Join-Path $ProjectDir 'package.json'
  $lockPath = Join-Path $ProjectDir 'package-lock.json'
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $lockPath)) {
    throw '项目文件不完整，请重新复制整个任务空间文件夹后双击启动。'
  }
  $cacheDir = Join-Path $ProjectDir '.runtime'
  $stampPath = Join-Path $cacheDir 'prepared.json'
  $stamp = $null
  if (Test-Path -LiteralPath $stampPath) {
    try { $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json }
    catch { $stamp = $null }
  }
  $dependencyKey = Get-WorkbenchFingerprint @(
    'setup-v1', $Node.Version, $Node.Architecture,
    (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash,
    (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
  )
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $missingDependency = $false
  foreach ($group in @($manifest.dependencies, $manifest.devDependencies)) {
    if ($null -eq $group) { continue }
    foreach ($dependency in $group.PSObject.Properties.Name) {
      if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules/$dependency/package.json"))) { $missingDependency = $true }
    }
  }
  $install = $missingDependency -or $null -eq $stamp -or $stamp.dependencies -ne $dependencyKey
  $buildInputs = @($dependencyKey)
  foreach ($file in @('index.html', 'vite.config.ts', 'tsconfig.json')) {
    $path = Join-Path $ProjectDir $file
    if (Test-Path -LiteralPath $path) { $buildInputs += "$file=$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)" }
  }
  foreach ($folder in @('web/src', 'public')) {
    $path = Join-Path $ProjectDir $folder
    if (Test-Path -LiteralPath $path) {
      foreach ($file in (Get-ChildItem -LiteralPath $path -File -Recurse | Sort-Object FullName)) {
        $relativePath = $file.FullName.Substring($ProjectDir.TrimEnd('\', '/').Length)
        $buildInputs += "$relativePath=$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
      }
    }
  }
  $buildKey = Get-WorkbenchFingerprint $buildInputs
  $build = $install -or $null -eq $stamp -or $stamp.build -ne $buildKey -or -not (Test-Path -LiteralPath (Join-Path $ProjectDir 'dist/index.html'))
  if (-not $install -and -not $build) { return }
  # 准备期间旧标记不再有效；中断或失败后，下一次启动必须重新验证。
  if (Test-Path -LiteralPath $stampPath) { Remove-Item -LiteralPath $stampPath -Force }
  Push-Location -LiteralPath $ProjectDir
  try {
    if ($install) {
      Write-Host '正在自动准备项目依赖，首次启动需要联网，请稍候…'
      Invoke-WorkbenchTool -Node $Node -EntryPoint $Node.NpmCli -Arguments @('ci', '--include=dev', '--no-audit', '--no-fund') -Label '依赖安装'
    }
    if ($build) {
      Write-Host '正在准备任务空间页面…'
      # 与项目的 vite build 相同，直接调用 JS 入口以支持含 & 等字符的目录。
      Invoke-WorkbenchTool -Node $Node -EntryPoint (Join-Path $ProjectDir 'node_modules/vite/bin/vite.js') -Arguments @('build') -Label '页面构建'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'dist/index.html'))) { throw '页面构建未生成完整文件，请重新双击启动以重试。' }
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $json = @{ dependencies = $dependencyKey; build = $buildKey } | ConvertTo-Json
    [IO.File]::WriteAllText($stampPath, $json, [Text.UTF8Encoding]::new($false))
  } finally { Pop-Location }
}
