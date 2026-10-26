import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/Workbench-Runtime.ps1');
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function powershell(source: string) {
  const env = { ...process.env };
  delete env.PSModulePath;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); . ${quote(script)}; & { ${source} } 6>$null`, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, env }).trim();
}

test('项目运行环境复用符合版本要求的系统 Node，不下载或修改 PATH', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-runtime-system-'));
  try {
    const result = JSON.parse(powershell(`
      $before = $env:PATH
      function Get-Command { param($Name, $CommandType, $ErrorAction); [pscustomobject]@{ Source = ${quote(process.execPath)} } }
      function Invoke-WebRequest { throw 'unexpected download' }
      $node = Get-WorkbenchNode -RuntimeRoot ${quote(root)}
      [pscustomobject]@{ Node = $node; SamePath = ($before -eq $env:PATH); Count = @(Get-ChildItem -LiteralPath ${quote(root)} -Force).Count } | ConvertTo-Json -Compress
    `));
    assert.equal(result.Node.Path, process.execPath);
    assert.equal(result.Node.Version, process.versions.node);
    assert.equal(result.Node.Architecture, process.arch);
    assert.match(result.Node.NpmCli, /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
    assert.equal(result.SamePath, true);
    assert.equal(result.Count, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('系统 Node 不可用时项目运行环境缓存可离线复用', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-runtime-cache-'));
  try {
    const result = JSON.parse(powershell(`
      function Get-Command { param($Name, $CommandType, $ErrorAction); [pscustomobject]@{ Source = 'C:\\not-an-installed-node\\node.exe' } }
      function Get-WorkbenchRuntimeArchitecture { 'x64' }
      function Get-WorkbenchNodeInfo {
        param($Path)
        if ($Path -eq (Join-Path ${quote(root)} 'node-v24.13.0-win-x64/node.exe')) {
          [pscustomobject]@{ Path = $Path; NpmCli = (Join-Path (Split-Path $Path) 'node_modules/npm/bin/npm-cli.js'); Version = '24.13.0'; Architecture = 'x64' }
        }
      }
      function Invoke-WebRequest { throw 'unexpected download' }
      Get-WorkbenchNode -RuntimeRoot ${quote(root)} | ConvertTo-Json -Compress
    `));
    assert.equal(result.Path, join(root, 'node-v24.13.0-win-x64', 'node.exe'));
    assert.equal(result.Version, '24.13.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('下载校验失败不会解压、执行或留下可用缓存，下次可以重新下载', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-runtime-bad-checksum-'));
  try {
    const result = JSON.parse(powershell(`
      function Get-Command { param($Name, $CommandType, $ErrorAction); $null }
      function Get-WorkbenchRuntimeArchitecture { 'x64' }
      function Get-WorkbenchNodeInfo { param($Path); $null }
      $script:downloads = 0
      function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec); $script:downloads++; [IO.File]::WriteAllText($OutFile, 'invalid zip') }
      function Expand-Archive { throw 'must not extract an unverified archive' }
      $errors = @()
      foreach ($attempt in 1..2) { try { Get-WorkbenchNode -RuntimeRoot ${quote(root)} | Out-Null } catch { $errors += $_.Exception.Message } }
      [pscustomobject]@{ Errors = $errors; Downloads = $script:downloads; Children = @(Get-ChildItem -LiteralPath ${quote(root)} -Force | Select-Object -ExpandProperty Name) } | ConvertTo-Json -Compress
    `));
    assert.equal(result.Downloads, 2);
    assert.equal(result.Errors.length, 2);
    assert.match(result.Errors[0], /校验/);
    assert.deepEqual(result.Children, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('校验成功后安装到专用目录，失败的旧缓存只在新包可用后替换', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-runtime-install-'));
  try {
    const result = JSON.parse(powershell(`
      function Get-Command { param($Name, $CommandType, $ErrorAction); $null }
      function Get-WorkbenchRuntimeArchitecture { 'arm64' }
      $target = Join-Path ${quote(root)} 'node-v24.13.0-win-arm64'
      New-Item -ItemType Directory -Path $target | Out-Null
      [IO.File]::WriteAllText((Join-Path $target 'incomplete'), 'old incomplete cache')
      $script:order = @()
      function Get-WorkbenchNodeInfo {
        param($Path)
        if (Test-Path -LiteralPath $Path) {
          $script:order += 'probe'
          [pscustomobject]@{ Path = $Path; NpmCli = (Join-Path (Split-Path $Path) 'node_modules/npm/bin/npm-cli.js'); Version = '24.13.0'; Architecture = 'arm64' }
        }
      }
      function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
        if ($Uri -ne 'https://nodejs.org/download/release/v24.13.0/node-v24.13.0-win-arm64.zip') { throw 'unexpected URL' }
        $script:order += 'download'
        [IO.File]::WriteAllText($OutFile, 'fixture')
      }
      function Get-FileHash { param($LiteralPath, $Algorithm); $script:order += 'verify'; [pscustomobject]@{ Hash = '92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a' } }
      function Expand-Archive {
        param($LiteralPath, $DestinationPath, [switch]$Force)
        if (-not (Test-Path -LiteralPath (Join-Path $target 'incomplete'))) { throw 'old cache removed before verified replacement' }
        $script:order += 'extract'
        $folder = Join-Path $DestinationPath 'node-v24.13.0-win-arm64'
        New-Item -ItemType Directory -Path $folder | Out-Null
        [IO.File]::WriteAllText((Join-Path $folder 'node.exe'), 'verified executable fixture')
      }
      $node = Get-WorkbenchNode -RuntimeRoot ${quote(root)}
      [pscustomobject]@{ Node = $node; Order = $script:order; Old = (Test-Path -LiteralPath (Join-Path $target 'incomplete')); Folders = @(Get-ChildItem -LiteralPath ${quote(root)} -Force | Select-Object -ExpandProperty Name) } | ConvertTo-Json -Compress
    `));
    assert.equal(result.Node.Path, join(root, 'node-v24.13.0-win-arm64', 'node.exe'));
    assert.equal(result.Node.Architecture, 'arm64');
    assert.deepEqual(result.Order, ['download', 'verify', 'extract', 'probe', 'probe']);
    assert.equal(result.Old, false);
    assert.deepEqual(result.Folders, ['node-v24.13.0-win-arm64']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('不把缺少 npm 的可执行文件当作可用系统 Node', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-runtime-no-npm-'));
  try {
    const result = powershell(`
      $candidate = Join-Path ${quote(root)} 'node.exe'
      [IO.File]::WriteAllText($candidate, 'not executable')
      $null -eq (Get-WorkbenchNodeInfo -Path $candidate)
    `);
    assert.equal(result, 'True');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('只允许受支持的 Windows 架构下载运行环境', { skip: process.platform !== 'win32' }, () => {
  assert.equal(powershell(`$env:PROCESSOR_ARCHITEW6432 = ''; $env:PROCESSOR_ARCHITECTURE = 'ARM64'; Get-WorkbenchRuntimeArchitecture`), 'arm64');
  assert.equal(powershell(`$env:PROCESSOR_ARCHITEW6432 = 'AMD64'; $env:PROCESSOR_ARCHITECTURE = 'x86'; Get-WorkbenchRuntimeArchitecture`), 'x64');
  assert.match(powershell(`$env:PROCESSOR_ARCHITEW6432 = ''; $env:PROCESSOR_ARCHITECTURE = 'x86'; try { Get-WorkbenchRuntimeArchitecture } catch { $_.Exception.Message }`), /不支持/);
});
