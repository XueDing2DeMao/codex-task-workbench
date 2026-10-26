import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { WorkbenchStore } from '../server/domain/store.ts';
import { createNativeReader } from '../server/native/service.ts';

const workbenchRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(process.env.CTW_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'CodexTaskWorkbench', 'desktop-data'));
const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
let server: Server | undefined;
let store: WorkbenchStore | undefined;
let stopping = false;

async function notify(message: { type: 'ready'; url: string } | { type: 'error'; message: string }): Promise<void> {
  if (process.send && process.connected) {
    await new Promise<void>((done, reject) => process.send!(message, error => error ? reject(error) : done()));
  } else if (!process.send) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }
}

function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  // 正常关闭先释放连接及数据库；仅在退出无法完成时结束本服务进程。
  const deadline = setTimeout(() => process.exit(exitCode || 1), 5_000);
  deadline.unref();
  const finish = () => {
    try { store?.close(); }
    finally {
      clearTimeout(deadline);
      if (process.connected) process.disconnect();
    }
  };
  if (server) {
    server.closeAllConnections();
    server.close(finish);
  } else finish();
}

async function failed(error: unknown): Promise<void> {
  if (stopping) return;
  const message = error instanceof Error ? error.message : String(error);
  try { await notify({ type: 'error', message: `桌面服务启动失败：${message}` }); }
  catch { /* 父进程已退出时仍需释放资源。 */ }
  finally { stop(1); }
}

process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') stop();
});
process.once('disconnect', () => stop());
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

try {
  await mkdir(dataDirectory, { recursive: true });
  if (!stopping) {
    store = new WorkbenchStore(join(dataDirectory, 'workbench.sqlite'));
    server = createApp({ store, dataDirectory, allowedRoots: [], webRoot: join(workbenchRoot, 'dist'), nativeReader: createNativeReader(codexHome) });
    server.once('error', error => { void failed(error); });
    server.listen(0, '127.0.0.1', () => {
      if (stopping) return;
      const address = server!.address();
      if (!address || typeof address === 'string') { void failed(new Error('未取得本地服务端口')); return; }
      void notify({ type: 'ready', url: `http://127.0.0.1:${address.port}` }).catch(error => failed(error));
    });
  }
} catch (error) { await failed(error); }
