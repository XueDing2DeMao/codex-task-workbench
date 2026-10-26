import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.ts';
import { WorkbenchStore } from '../server/domain/store.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ctw-http-'));
  const history = join(root, 'history'); const webRoot = join(root, 'web'); const dataDirectory = join(root, 'data');
  await mkdir(history); await mkdir(webRoot); await mkdir(dataDirectory);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Local Workbench</title>');
  const store = new WorkbenchStore(join(dataDirectory, 'test.sqlite'));
  const server = createApp({ store, dataDirectory, allowedRoots: [history], webRoot });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const url = `http://127.0.0.1:${address.port}`;
  const init = await fetch(`${url}/api/bootstrap`); const config = await init.json();
  const headers = { Cookie: init.headers.get('set-cookie')!.split(';')[0], 'X-Workbench-Token': config.csrfToken, 'Content-Type': 'application/json' };
  const request = (path: string, method = 'GET', input?: unknown) => fetch(url + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
  return { root, history, url, headers, store, request, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('HTTP bootstraps a local session but rejects foreign origin and unauthenticated reads', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.url + '/api/overview')).status, 403);
    assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { Origin: 'https://outside.example' } })).status, 403);
    const page = await fetch(f.url + '/');
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /Local Workbench/);
    const incomingLink = await fetch(f.url + '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' } });
    assert.equal(incomingLink.status, 200, '从其他应用点击链接应可打开静态入口');
    assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/api/overview')).status, 200);
    const bad = await fetch(f.url + '/api/projects', { method: 'POST', headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 403);
  } finally { await f.close(); }
});

test('HTTP imports an allowed JSONL copy, retrieves Chinese text and leaves source bytes unchanged', async () => {
  const f = await fixture();
  try {
    const path = join(f.history, 'rollout.jsonl');
    const original = [
      { type: 'session_meta', payload: { id: 'http-session', cwd: '/test' } },
      { type: 'response_item', timestamp: '2026-10-26T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修改任务，只查询最近7天' }] } },
    ].map(v => JSON.stringify(v)).join('\n') + '\n';
    await writeFile(path, original);
    const project = await (await f.request('/api/projects', 'POST', { name: 'HTTP 测试' })).json();
    const imported = await f.request('/api/sources/import', 'POST', { projectId: project.id, paths: [path] });
    const importResult = await imported.json();
    assert.equal(imported.status, 200, JSON.stringify(importResult)); assert.ok(importResult.inserted > 0);
    const result = await (await f.request('/api/search?q=' + encodeURIComponent('修改') + '&scope=instructions')).json();
    assert.equal(result.total, 1); assert.match(result.items[0].text, /最近7天/);
    const context = await (await f.request(`/api/records/${result.items[0].id}/context`)).json();
    assert.ok(context.some((r: { text: string }) => r.text.includes('最近7天')));
    assert.equal(await readFile(path, 'utf8'), original);
    const refused = await f.request('/api/sources/import', 'POST', { projectId: project.id, paths: [join(f.root, 'data', 'test.sqlite')] });
    assert.equal(refused.status, 403);
  } finally { await f.close(); }
});

test('HTTP rejects forged imported acceptance and keeps draft activation explicit', async () => {
  const f = await fixture();
  try {
    const project = await (await f.request('/api/projects', 'POST', { name: '版本测试' })).json();
    const content = { goal: '检索修改指令', requirements: ['旧指令可查'], scope: '本地', nonGoals: '云端', criteria: [{ id: 'AC-1', text: '查询旧指令可定位原文', required: true }], sourceIds: [], conflicts: [] };
    const created = await f.request('/api/tasks', 'POST', { projectId: project.id, title: '查询任务', content });
    assert.equal(created.status, 200);
    const task = await created.json(); assert.equal(task.task.currentRevisionId, null);
    const activated = await (await f.request(`/api/tasks/${task.task.id}/activate`, 'POST', { expectedVersion: task.task.lockVersion })).json();
    assert.ok(activated.task.currentRevisionId);
    assert.equal((await f.request('/api/receipts', 'POST', { receiptId: 'forged', acceptance: 'accepted' })).status, 400);
    assert.equal((await f.request(`/api/tasks/${task.task.id}/activate`, 'POST', { expectedVersion: task.task.lockVersion })).status, 409);
    const exported = await (await f.request(`/api/tasks/${task.task.id}/export`)).json();
    assert.match(exported.markdown, /查询任务/);
    const backup = await (await f.request('/api/backup')).json();
    assert.equal(backup.format, 'codex-task-workbench');
    const restored = await f.request('/api/restore', 'POST', backup);
    assert.equal(restored.status, 200);
    const restoration = await restored.json();
    assert.equal(restoration.restartRequired, true); assert.equal(restoration.tasks, 1);
    // 恢复目录保留在本测试创建的临时根内，由 fixture 统一清理。
    assert.ok(restoration.restoredDirectory.startsWith(join(f.root, 'restored-')));
  } finally { await f.close(); }
});
