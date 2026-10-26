import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeCatalog, NativeSearchResult, NativeTaskDetail } from '../shared/native-contracts.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const threadId = '11111111-1111-4111-8111-111111111111';

async function availablePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => listener.close(() => done()));
  return address.port;
}

async function createCodexFixture(codexHome: string) {
  await mkdir(codexHome);
  const catalog = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  try {
    catalog.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
      CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,project_id TEXT,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);`);
    catalog.prepare('INSERT INTO projects VALUES(?,?,?)').run('new-computer', '新电脑项目', 0);
    catalog.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('new-computer', 0, 'C:/new-computer/project');
    catalog.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(threadId, '首次自动读取任务', 'C:/new-computer/project', 'vscode', 'new-computer', 1790000000, 1790000001, '');
  } finally { catalog.close(); }
  const history = new DatabaseSync(join(codexHome, 'thread_history_1.sqlite'));
  try {
    history.exec(`CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT);
      CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER);
      CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER);`);
    history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?)').run(threadId, 'turn-1', 1, 'completed', 1790000000);
    const insert = history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
    insert.run(threadId, 'turn-1', 'requirement', 2, 1790000000000, JSON.stringify({ content: [{ type: 'text', text: '首次打开自动检索数据，无需命令行导入' }] }), 'userMessage');
    insert.run(threadId, 'turn-1', 'answer', 3, 1790000000001, JSON.stringify({ phase: 'final_answer', text: '已展示完整项目与输出' }), 'agentMessage');
  } finally { history.close(); }
  await writeFile(join(codexHome, '.codex-global-state.json'), '{}');
}

test('全新数据区启动后自动读取 CODEX_HOME，首次查询直接获得项目和全文，原始数据不变', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-first-start-'));
  const codexHome = join(root, 'codex-source');
  const dataDirectory = join(root, 'fresh-workbench');
  await createCodexFixture(codexHome);
  const sourceFiles = await readdir(codexHome);
  const before = await Promise.all(sourceFiles.map(async name => ({ name, contents: await readFile(join(codexHome, name)), modified: (await stat(join(codexHome, name))).mtimeMs })));
  await assert.rejects(stat(dataDirectory), { code: 'ENOENT' });
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.ts', '--data-dir', dataDirectory, '--port', String(port)], {
    cwd: projectRoot, env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = ''; let spawnError: Error | undefined;
  child.stderr.on('data', chunk => { errors += String(chunk); });
  child.stdout.resume();
  child.on('error', error => { spawnError = error; });
  try {
    let bootstrap: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`测试服务提前退出：${errors}`);
      try { bootstrap = await fetch(base + '/api/bootstrap', { signal: AbortSignal.timeout(500) }); }
      catch { /* 服务尚未监听时重试。 */ }
      if (bootstrap?.ok) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(bootstrap?.ok, `首次启动服务未就绪：${errors}`);
    assert.equal((await bootstrap.json()).dataDirectory, dataDirectory);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<T>;
    };

    // 与页面首次打开相同，只调用读取接口，不执行导入或创建任务。
    const catalog = await get<NativeCatalog>('/api/native/catalog');
    assert.deepEqual(catalog.projects.map(project => [project.id, project.name, project.taskCount]), [['new-computer', '新电脑项目', 1]]);
    assert.deepEqual(catalog.tasks.map(task => task.id), [threadId]);
    assert.equal(catalog.coverage.loadedTasks, 1);
    const detail = await get<NativeTaskDetail>(`/api/native/tasks/${threadId}`);
    assert.deepEqual(detail.exchanges[0].requirements, ['首次打开自动检索数据，无需命令行导入']);
    assert.equal(detail.exchanges[0].outputs[0].text, '已展示完整项目与输出');
    for (const query of ['自动检索', '完整项目与输出']) {
      const result = await get<NativeSearchResult>('/api/native/search?q=' + encodeURIComponent(query));
      assert.deepEqual(result.tasks.map(task => task.id), [threadId]);
      assert.equal(result.tasks[0].matchTurnId, 'turn-1');
    }
    assert.deepEqual(await get('/api/tasks'), [], '原生读取无需预先导入到工作台任务库');
    assert.deepEqual(await readdir(codexHome), sourceFiles, '不新增 Codex 源目录文件');
    for (const original of before) {
      assert.deepEqual(await readFile(join(codexHome, original.name)), original.contents);
      assert.equal((await stat(join(codexHome, original.name))).mtimeMs, original.modified);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep), '仅清理本次创建的临时测试目录');
    await rm(root, { recursive: true, force: true });
  }
});
