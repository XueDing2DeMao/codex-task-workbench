import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const setupScript = resolve('scripts/Workbench-Setup.ps1');
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctw-首次启动 & user's-"));
  await mkdir(join(root, 'web/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '1.0.0' }, devDependencies: { vite: '1.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(root, 'index.html'), '<html></html>');
  await writeFile(join(root, 'web/src/main.ts'), 'export const title = "任务空间";');
  const npm = join(root, 'fake-npm.cjs');
  const buildTool = `const fs = require('node:fs');
fs.appendFileSync('calls.txt', 'build\\n');
if (fs.existsSync('fail-build.txt')) process.exit(8);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<html>ready</html>');`;
  await writeFile(npm, `const fs = require('node:fs');
const command = process.argv.slice(2).join(' ');
fs.appendFileSync('calls.txt', command + '\\n');
if (fs.existsSync('fail.txt')) process.exit(9);
if (process.argv[2] === 'ci') {
  for (const name of ['react', 'vite']) {
    fs.mkdirSync('node_modules/' + name, { recursive: true });
    fs.writeFileSync('node_modules/' + name + '/package.json', '{}');
  }
  fs.mkdirSync('node_modules/vite/bin', { recursive: true });
  fs.writeFileSync('node_modules/vite/bin/vite.js', ${JSON.stringify(buildTool)});
}
`);
  return { root, npm };
}

function prepare(root: string, npm: string) {
  const script = `$ErrorActionPreference = 'Stop'; . ${psQuote(setupScript)}; ` +
    `$runtime = [pscustomobject]@{ Path = ${psQuote(process.execPath)}; NpmCli = ${psQuote(npm)}; Version = '${process.versions.node}'; Architecture = '${process.arch}' }; ` +
    `Initialize-WorkbenchAssets -ProjectDir ${psQuote(root)} -Node $runtime`;
  // 模拟资源管理器启动，避免开发机 PowerShell 7 的模块目录污染 Windows PowerShell 5.1。
  const env = { ...process.env }; delete env.PSModulePath;
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe', env });
}

const options = { skip: process.platform !== 'win32' };
test('首次启动自动安装并构建；重复启动复用，源码变化只重建页面', options, async () => {
  const { root, npm } = await fixture();
  try {
    prepare(root, npm);
    const initial = await readFile(join(root, 'calls.txt'), 'utf8');
    assert.match(initial, /^ci --include=dev --no-audit --no-fund\r?\nbuild\r?\n$/);
    assert.match(await readFile(join(root, 'dist/index.html'), 'utf8'), /ready/);
    prepare(root, npm);
    assert.equal(await readFile(join(root, 'calls.txt'), 'utf8'), initial);
    await writeFile(join(root, 'web/src/main.ts'), 'export const title = "更新页面";');
    prepare(root, npm);
    assert.equal(await readFile(join(root, 'calls.txt'), 'utf8'), initial + 'build\n');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    prepare(root, npm);
    assert.equal(await readFile(join(root, 'calls.txt'), 'utf8'), initial + 'build\n' + initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('安装失败不标记完成；再次双击能重试，缺失依赖也能恢复', options, async () => {
  const { root, npm } = await fixture();
  try {
    await writeFile(join(root, 'fail.txt'), 'fail');
    assert.throws(() => prepare(root, npm));
    await assert.rejects(readFile(join(root, '.runtime/prepared.json')), { code: 'ENOENT' });
    await rm(join(root, 'fail.txt'));
    prepare(root, npm);
    await rm(join(root, 'node_modules/react/package.json'));
    prepare(root, npm);
    const calls = await readFile(join(root, 'calls.txt'), 'utf8');
    assert.equal(calls.split('\n').filter(line => line.startsWith('ci ')).length, 3);
    assert.equal(calls.split('\n').filter(line => line === 'build').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('已有成功缓存的重新准备失败后必须重试，不能复用旧完成标记', options, async () => {
  const { root, npm } = await fixture();
  try {
    prepare(root, npm);
    await rm(join(root, 'node_modules/react/package.json'));
    await writeFile(join(root, 'fail-build.txt'), 'fail');
    assert.throws(() => prepare(root, npm));
    await assert.rejects(readFile(join(root, '.runtime/prepared.json')), { code: 'ENOENT' });
    await rm(join(root, 'fail-build.txt'));
    prepare(root, npm);
    const calls = await readFile(join(root, 'calls.txt'), 'utf8');
    assert.equal(calls.split('\n').filter(line => line === 'build').length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
