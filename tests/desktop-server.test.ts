import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const entry = resolve('desktop/server-entry.ts');
type ReadyMessage = { type: 'ready'; url: string };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ctw-desktop-中文 & space-'));
  const codexHome = join(root, 'codex-source');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const rollout = join(codexHome, 'sessions', 'rollout.jsonl');
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  try {
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
      CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,project_id TEXT,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);
      INSERT INTO projects VALUES('desktop-project','桌面项目',0);
      INSERT INTO project_roots VALUES('desktop-project',0,'C:/desktop-project');`);
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run('desktop-task', '自动读取任务', 'C:/desktop-project', 'vscode', 'desktop-project', 1790000000, 1790000001, rollout);
  } finally { db.close(); }
  await writeFile(join(codexHome, '.codex-global-state.json'), '{}');
  await writeFile(rollout, [
    { type: 'session_meta', payload: { id: 'desktop-task', cwd: 'C:/desktop-project', source: 'vscode' } },
    { type: 'turn_context', payload: { turn_id: 'first-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '桌面首次自动检索要求' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '桌面完整输出' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  return { root, codexHome, dataDirectory: join(root, 'desktop-data') };
}

async function sourceState(root: string): Promise<Record<string, { hash: string; modified: number }>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const result: Record<string, { hash: string; modified: number }> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result[path] = { hash: createHash('sha256').update(await readFile(path)).digest('hex'), modified: (await stat(path)).mtimeMs };
  }
  return result;
}

function start(f: Awaited<ReturnType<typeof fixture>>) {
  const child = fork(entry, [], { execPath: process.execPath, execArgv: [], silent: true, windowsHide: true,
    env: { ...process.env, CODEX_HOME: f.codexHome, CTW_DATA_DIR: f.dataDirectory } });
  let logs = '';
  child.stdout!.on('data', chunk => { logs += String(chunk); });
  child.stderr!.on('data', chunk => { logs += String(chunk); });
  const ready = new Promise<ReadyMessage>((accept, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`桌面服务启动超时：${logs}`)); }, 8_000);
    const message = (value: unknown) => {
      const data = value as { type?: string; url?: string; message?: string };
      if (data.type === 'ready') { cleanup(); accept(data as ReadyMessage); }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
    };
    const failure = () => { cleanup(); reject(new Error(`桌面服务提前退出：${logs}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off('message', message); child.off('error', failure); child.off('exit', failure); };
    child.on('message', message); child.once('error', failure); child.once('exit', failure);
  });
  return { child, ready };
}

async function cleanup(root: string, child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep), '仅清理本测试创建的临时目录');
  await rm(root, { recursive: true, force: true });
}

test('桌面服务自动选择回环端口，首次读取/检索和退出不修改 Codex 源数据', { timeout: 15_000 }, async () => {
  const f = await fixture(); const before = await sourceState(f.codexHome);
  const { child, ready } = start(f);
  try {
    const { url } = await ready;
    const address = new URL(url);
    assert.equal(address.hostname, '127.0.0.1');
    assert.ok(Number(address.port) > 0);
    const init = await fetch(url + '/api/bootstrap');
    assert.equal(init.status, 200);
    assert.equal((await init.json()).dataDirectory, f.dataDirectory);
    const cookie = init.headers.get('set-cookie')!.split(';')[0];
    const get = async (path: string) => {
      const response = await fetch(url + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); return response.json();
    };
    const catalog = await get('/api/native/catalog');
    assert.deepEqual(catalog.projects.map((p: { name: string }) => p.name), ['桌面项目']);
    assert.equal(catalog.tasks.length, 1);
    for (const term of ['自动检索', '完整输出']) {
      const result = await get('/api/native/search?q=' + encodeURIComponent(term));
      assert.deepEqual(result.tasks.map((t: { id: string }) => t.id), ['desktop-task']);
    }
    const exited = once(child, 'exit');
    child.send({ type: 'shutdown' });
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(fetch(url + '/api/bootstrap'));
    assert.deepEqual(await sourceState(f.codexHome), before);
  } finally { await cleanup(f.root, child); }
});

test('父进程 IPC 断开时桌面服务自动退出，不遗留监听端口', { timeout: 15_000 }, async () => {
  const f = await fixture(); const { child, ready } = start(f);
  try {
    const { url } = await ready;
    const exited = once(child, 'exit');
    child.disconnect();
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(fetch(url + '/api/bootstrap'));
  } finally { await cleanup(f.root, child); }
});

test('父进程在入口加载期间断开也不会留下孤儿服务', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const child = fork(entry, [], { execPath: process.execPath, execArgv: [], silent: true, windowsHide: true,
    env: { ...process.env, CODEX_HOME: f.codexHome, CTW_DATA_DIR: f.dataDirectory } });
  child.stdout!.resume(); child.stderr!.resume();
  try {
    const exited = once(child, 'exit');
    child.disconnect();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('父进程已断开，桌面服务仍未退出')), 3_000); })]);
      assert.deepEqual(result, [0, null]);
    } finally { if (timer) clearTimeout(timer); }
  } finally { await cleanup(f.root, child); }
});

test('启动失败通过 IPC 返回错误并以非零状态退出', { timeout: 15_000 }, async () => {
  const f = await fixture();
  await writeFile(f.dataDirectory, '不是目录');
  const { child, ready } = start(f);
  try {
    const exited = once(child, 'exit');
    await assert.rejects(ready, /目录|EEXIST|ENOTDIR/);
    const [code] = await exited;
    assert.notEqual(code, 0);
  } finally { await cleanup(f.root, child); }
});
