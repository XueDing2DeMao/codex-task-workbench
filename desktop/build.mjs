import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const desktop = dirname(fileURLToPath(import.meta.url));
const project = resolve(desktop, '..');
const require = createRequire(import.meta.url);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: project, stdio: 'inherit', windowsHide: true, ...options });
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前打包入口面向 Windows x64。');
run(process.execPath, [join(project, 'node_modules/vite/bin/vite.js'), 'build']);
await mkdir(join(desktop, '.runtime/node'), { recursive: true });
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const command = `$ErrorActionPreference = 'Stop'; . ${psQuote(join(project, 'scripts/Workbench-Runtime.ps1'))}; ` +
  `$runtime = Get-WorkbenchNode -RuntimeRoot ${psQuote(join(desktop, '.runtime/runtime-cache'))}; $runtime | ConvertTo-Json -Compress`;
const env = { ...process.env }; delete env.PSModulePath;
const output = run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env, stdio: 'pipe', encoding: 'utf8' });
const runtime = JSON.parse(output.trim().split(/\r?\n/).at(-1));
if (runtime.Architecture !== 'x64') throw new Error('Windows x64 安装包需要 x64 Node 运行环境。');
await copyFile(runtime.Path, join(desktop, '.runtime/node/node.exe'));
await copyFile(join(dirname(runtime.Path), 'LICENSE'), join(desktop, '.runtime/node/LICENSE'));
await writeFile(join(desktop, '.runtime/workbench-package.json'), JSON.stringify({ type: 'module', private: true }));
const { build } = require('electron-builder');
const artifacts = await build({ projectDir: desktop, config: require('./electron-builder.cjs'), publish: 'never' });
console.log('桌面构建完成：\n' + artifacts.join('\n'));
