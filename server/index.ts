import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchStore } from './domain/store.ts';
import { createApp } from './app.ts';
import { createNativeReader } from './native/service.ts';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDirectory = resolve(option('--data-dir') ?? process.env.CTW_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'CodexTaskWorkbench'));
const port = Number(option('--port') ?? process.env.CTW_PORT ?? 43127);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在 1024–65535');
const allowedRoots = [
  join(homedir(), '.codex', 'sessions'), join(homedir(), '.codex', 'archived_sessions'),
  join(appRoot, '..', 'codex任务优化', 'test-data', 'history-viewer-local'),
  ...args.flatMap((arg, i) => arg === '--allow-root' && args[i + 1] ? [resolve(args[i + 1])] : []),
];
await mkdir(dataDirectory, { recursive: true });
const store = new WorkbenchStore(join(dataDirectory, 'workbench.sqlite'));
const nativeReader = createNativeReader(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')));
const server = createApp({ store, dataDirectory, allowedRoots, webRoot: join(appRoot, 'dist'), nativeReader, onShutdown: () => stop() });
server.on('error', error => { console.error('无法启动工作台：', error.message); store.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Codex 任务工作台 http://127.0.0.1:${port}`);
  console.log(`数据目录：${dataDirectory}`);
  console.log('当前读取模式：本机 Codex 只读目录与完整对话，包含归档及子任务。');
});
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections();
  server.close(() => { store.close(); process.exitCode = 0; });
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
