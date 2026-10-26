import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.ts';
import { WorkbenchStore } from '../server/domain/store.ts';
import { ApiError } from '../server/security.ts';
import type { NativeExportRequest } from '../shared/native-contracts.ts';

test('Markdown 导出通过受保护的 POST 返回正文，拒绝跨站、无令牌、额外字段并传递读取失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-export-http-'));
  const webRoot = join(root, 'web'); await mkdir(webRoot);
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const calls: NativeExportRequest[] = [];
  const input: NativeExportRequest = { projectId: 'p', scope: 'tasks', taskIds: ['task-a', 'task-b'], includeRelated: false };
  const result = { filename: '中文项目_所选2项任务.md', markdown: '# 中文项目\n\n原始需求\n\n```ts\nconst x = 1;\n```\n', readAt: '2026-10-26T07:00:00Z', taskCount: 2 };
  const server = createApp({ store, dataDirectory: root, allowedRoots: [], webRoot, nativeReader: {
    catalog: async () => { throw new Error('导出不应逐个读取目录'); },
    task: async () => { throw new Error('导出不应逐个读取任务'); },
    search: async () => { throw new Error('导出不应执行搜索'); },
    exportExchange: async () => { throw new Error('项目导出不应调用单轮导出'); },
    exportMarkdown: async request => {
      calls.push(request);
      if (request.projectId === 'unreadable') throw new ApiError(503, '未能读取任务：任务 A', 'NATIVE_EXPORT_UNAVAILABLE');
      return result;
    },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const base = `http://127.0.0.1:${address.port}`;
  const url = base + '/api/native/export/markdown';
  try {
    const bootstrap = await fetch(base + '/api/bootstrap');
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await bootstrap.json();
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workbench-Token': csrfToken };
    const post = (value: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(value) });
    assert.equal((await post(input, { Cookie: '' })).status, 403);
    assert.equal((await post(input, { 'X-Workbench-Token': '' })).status, 403);
    assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(input, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(calls.length, 0);

    const response = await post(input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), result);
    assert.deepEqual(calls, [input]);
    assert.equal((await post({ ...input, outputPath: 'C:/not-allowed.md' })).status, 400);
    assert.equal((await post(null)).status, 400);
    assert.equal((await post([])).status, 400);
    assert.equal(calls.length, 1, '拒绝非法结构后才调用原生读取器');
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 404);
    const failed = await post({ ...input, projectId: 'unreadable' });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'NATIVE_EXPORT_UNAVAILABLE', message: '未能读取任务：任务 A' });
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\'), '只清理此次创建的临时测试目录');
    await rm(root, { recursive: true, force: true });
  }
});

test('单轮 Markdown 接口仅接收任务与轮次ID，保留会话保护并传递定位失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-exchange-http-'));
  const webRoot = join(root, 'web'); await mkdir(webRoot);
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const calls: { taskId: string; exchangeId: string }[] = [];
  const input = { taskId: 'task-a', exchangeId: 'turn-15' };
  const result = { filename: '任务_第15轮.md', markdown: '# 项目\n\n## 第 15 轮\n\n需求与输出', readAt: '2026-10-26T07:00:00Z', taskCount: 1 };
  const unused = async () => { throw new Error('不应调用其他读取接口'); };
  const server = createApp({ store, dataDirectory: root, allowedRoots: [], webRoot, nativeReader: {
    catalog: unused, task: unused, search: unused, exportMarkdown: unused,
    exportExchange: async request => {
      calls.push(request);
      if (request.exchangeId === 'missing') throw new ApiError(404, '没有找到本轮内容，请刷新后重试');
      return result;
    },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const base = `http://127.0.0.1:${address.port}`;
  const url = base + '/api/native/export/exchange';
  try {
    const bootstrap = await fetch(base + '/api/bootstrap');
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await bootstrap.json();
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workbench-Token': csrfToken };
    const post = (value: unknown, extra: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    assert.equal((await post(input, { Cookie: '' })).status, 403);
    assert.equal((await post(input, { 'X-Workbench-Token': '' })).status, 403);
    assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
    assert.equal(calls.length, 0);
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), result);
    assert.deepEqual(calls, [input]);
    assert.equal((await post({ ...input, markdown: '不可信正文' })).status, 400);
    assert.equal((await post({ ...input, taskIds: ['other'] })).status, 400);
    assert.equal((await post(null)).status, 400);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 404);
    const failed = await post({ ...input, exchangeId: 'missing' });
    assert.equal(failed.status, 404);
    assert.match((await failed.json()).message, /没有找到本轮内容/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\'));
    await rm(root, { recursive: true, force: true });
  }
});
