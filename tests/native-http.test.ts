import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.ts';
import { WorkbenchStore } from '../server/domain/store.ts';
import { ApiError } from '../server/security.ts';
import { buildNativeSnapshot, searchNativeSnapshot } from '../server/native/service.ts';

test('本机目录/详情/全文检索沿用同源会话保护，拒绝未认证和路径注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-native-http-')); const webRoot = join(root, 'web'); await mkdir(webRoot);
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const snapshot = buildNativeSnapshot({ projects: [{ id: 'p', name: '项目', rootPath: '' }], threads: [{ id: 't', projectId: 'p', title: '任务', cwd: '', source: 'user', archived: true, createdAt: '', updatedAt: '' }], warnings: [] }, { threads: [{ id: 't', turns: [{ id: 'turn', requirements: ['输入要求'], outputs: [{ id: 'out', text: '全量搜索结果' }] }] }], warnings: [] });
  let reads = 0;
  const server = createApp({ store, dataDirectory: root, allowedRoots: [], webRoot, nativeReader: {
    catalog: async () => { reads++; return snapshot.catalog; },
    task: async id => { reads++; const task = snapshot.details.get(id); if (!task) throw new ApiError(404, '任务不存在'); return task; },
    search: async query => { reads++; return searchNativeSnapshot(snapshot, query); },
    exportMarkdown: async () => { throw new Error('此读取测试不应调用导出'); },
    exportExchange: async () => { throw new Error('此读取测试不应调用单轮导出'); },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(url + '/api/native/catalog')).status, 403); assert.equal(reads, 0);
    const init = await fetch(url + '/api/bootstrap'); const cookie = init.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie };
    assert.equal((await fetch(url + '/api/native/catalog', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403); assert.equal(reads, 0);
    const catalog = await (await fetch(url + '/api/native/catalog', { headers })).json(); assert.equal(catalog.tasks.length, 1);
    const detail = await (await fetch(url + '/api/native/tasks/t', { headers })).json(); assert.equal(detail.exchanges[0].outputs[0].text, '全量搜索结果');
    const result = await (await fetch(url + '/api/native/search?q=' + encodeURIComponent('全量'), { headers })).json(); assert.equal(result.tasks.length, 1);
    assert.equal((await fetch(url + '/api/native/search?q=' + 'x'.repeat(151), { headers })).status, 400);
    assert.equal((await fetch(url + '/api/native/tasks/..%2Fauth.json', { headers })).status, 404);
    assert.equal((await fetch(url + '/api/native/catalog', { method: 'POST', headers })).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true });
  }
});
