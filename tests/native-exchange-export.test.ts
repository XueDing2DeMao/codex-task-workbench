import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import * as native from '../server/native/service.ts';
import type { NativeSnapshot } from '../server/native/service.ts';
import type { NativeThreadMeta } from '../server/native/catalog.ts';
import type { NativeExchange, NativeExchangeExportRequest, NativeExportResult } from '../shared/native-contracts.ts';

const readAt = '2026-10-26T07:00:00.000Z';
const exportedAt = new Date('2026-10-26T07:01:00.000Z');
const thread = (id: string, extra: Partial<NativeThreadMeta> = {}): NativeThreadMeta => ({ id, title: `任务 ${id}`, projectId: 'p', cwd: '', source: 'user', archived: false, createdAt: readAt, updatedAt: readAt, ...extra });
const turn = (id: string): NativeExchange => ({ id, requirements: [`需求 ${id}`], outputs: [{ id: `out-${id}`, text: `输出 ${id}` }] });
function snapshot(records = [thread('root')], turns = new Map([['root', [turn('first'), turn('second')]]]), unavailableIds: string[] = []) {
  return native.buildNativeSnapshot({ projects: [{ id: 'p', name: '材料项目', rootPath: '' }], threads: records, warnings: [] },
    { threads: records.map(record => ({ id: record.id, turns: turns.get(record.id) ?? [] })), warnings: [], unavailableIds }, readAt);
}
function exportExchange(data: NativeSnapshot, input: NativeExchangeExportRequest): NativeExportResult {
  const fn = (native as unknown as { exportNativeExchange?: (data: NativeSnapshot, input: NativeExchangeExportRequest, date: Date) => NativeExportResult }).exportNativeExchange;
  assert.equal(typeof fn, 'function', '应提供按轮次 ID 导出能力');
  return fn!(data, input, exportedAt);
}

test('按轮次ID只导出第15轮完整需求和全部输出，保留原始轮序及Markdown', () => {
  const requirement = '# 原文标题\n\n**保留格式**\n\n```ts\nconst x = `中文`;\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 样本 | 合格 |';
  const output = '结果正文\n\n[文件](./result.md)\n\n尾部空格  \n';
  const exchanges = Array.from({ length: 16 }, (_, index) => turn(`round-${index + 1}`));
  exchanges[14] = { id: 'round-15', requirements: [requirement, '本轮补充要求'], outputs: [{ id: 'o1', text: output }, { id: 'o2', text: '本轮第二条输出' }] };
  const data = snapshot([thread('root')], new Map([['root', exchanges]]));
  const before = JSON.stringify([...data.details]);
  const result = exportExchange(data, { taskId: 'root', exchangeId: 'round-15' });
  assert.equal(result.taskCount, 1); assert.equal(result.readAt, readAt);
  assert.match(result.markdown, /材料项目/); assert.match(result.markdown, /任务 root/);
  assert.match(result.markdown, /任务 ID：root/); assert.match(result.markdown, /轮次 ID：round-15/);
  assert.match(result.markdown, /^> \[!note\] 第 15 轮$/m); assert.match(result.filename, /_第15轮_20261026-150100\.md$/);
  assert.match(result.markdown, /2026-10-26 15:00:00 \+08:00/);
  assert.match(result.markdown, /2026-10-26 15:01:00 \+08:00/);
  const content = result.markdown.split('\n').map(line => line === '>' ? '' : line.startsWith('> ') ? line.slice(2) : line).join('\n');
  assert.ok(content.includes(requirement)); assert.ok(content.includes(output));
  assert.ok(content.indexOf(requirement) < content.indexOf('本轮补充要求'));
  assert.ok(content.indexOf(output) < content.indexOf('本轮第二条输出'));
  assert.doesNotMatch(result.markdown, /需求 round-14|输出 round-14|需求 round-16|输出 round-16/);
  assert.equal((result.markdown.match(/^> \[!note\] 第 \d+ 轮$/gm) ?? []).length, 1);
  assert.match(result.markdown, /\n> ---\n>\n> \*\*对应输出\*\*\n/);
  assert.equal(JSON.stringify([...data.details]), before);
});

test('相同轮次ID仅在指定任务内查找，不混入其他任务或关联任务', () => {
  const records = [thread('root'), thread('other'), thread('child', { source: 'subagent', parentId: 'root' })];
  const data = snapshot(records, new Map([
    ['root', [{ id: 'shared', requirements: ['主任务指定需求'], outputs: [] }]],
    ['other', [{ id: 'shared', requirements: ['其他任务需求'], outputs: [] }]],
    ['child', [{ id: 'shared', requirements: ['子任务需求'], outputs: [] }]],
  ]));
  const { markdown } = exportExchange(data, { taskId: 'root', exchangeId: 'shared' });
  assert.match(markdown, /主任务指定需求/); assert.doesNotMatch(markdown, /其他任务需求|子任务需求/);
});

test('单轮无输出或无需求使用明确标记，正文不完整则拒绝导出', () => {
  const data = snapshot([thread('root')], new Map([['root', [
    { id: 'pending', requirements: ['正在处理的需求'], outputs: [] },
    { id: 'output-only', requirements: [], outputs: [{ id: 'out', text: '保留输出' }] },
  ]]]));
  assert.match(exportExchange(data, { taskId: 'root', exchangeId: 'pending' }).markdown, /暂无对应输出/);
  assert.match(exportExchange(data, { taskId: 'root', exchangeId: 'output-only' }).markdown, /本轮未记录用户需求/);
  const unavailable = snapshot([thread('root')], new Map([['root', [turn('first')]]]), ['root']);
  assert.throws(() => exportExchange(unavailable, { taskId: 'root', exchangeId: 'first' }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as { code: string }).code, 'NATIVE_EXPORT_INCOMPLETE'); return true;
  });
});

test('子任务和审查轮次可独立导出，并标明来源与父任务ID', () => {
  const data = snapshot([thread('root'), thread('child', { source: 'subagent', parentId: 'root' }), thread('review', { source: 'guardian', parentId: 'child', archived: true })],
    new Map([['root', [turn('root-turn')]], ['child', [turn('child-turn')]], ['review', [turn('review-turn')]]]));
  const child = exportExchange(data, { taskId: 'child', exchangeId: 'child-turn' });
  assert.match(child.markdown, /任务来源：子任务/); assert.match(child.markdown, /父任务 ID：root/);
  assert.doesNotMatch(child.markdown, /输出 root-turn|输出 review-turn/);
  const review = exportExchange(data, { taskId: 'review', exchangeId: 'review-turn' });
  assert.match(review.markdown, /任务来源：审查任务/); assert.match(review.markdown, /父任务 ID：child/);
  assert.equal(review.taskCount, 1);
});

test('未知、不匹配或空ID与额外字段被拒绝，不接受客户端正文或轮次序号', () => {
  const data = snapshot();
  const invalid: unknown[] = [null, [], {}, { taskId: '', exchangeId: 'first' }, { taskId: 'root', exchangeId: ' ' }, { taskId: [], exchangeId: 'first' },
    { taskId: 'root', exchangeId: ['first'] }, { taskId: 'root', exchangeId: 'first', number: 1 }, { taskId: 'root', exchangeId: 'first', markdown: '伪造正文' }];
  for (const input of invalid) assert.throws(() => exportExchange(data, input as NativeExchangeExportRequest), (error: unknown) => (error as { status: number }).status === 400, JSON.stringify(input));
  for (const input of [{ taskId: 'gone', exchangeId: 'first' }, { taskId: 'root', exchangeId: 'other-thread-turn' }]) {
    assert.throws(() => exportExchange(data, input), (error: unknown) => (error as { status: number }).status === 404);
  }
  const noProject = snapshot([thread('root', { projectId: 'missing-project' })]);
  assert.throws(() => exportExchange(noProject, { taskId: 'root', exchangeId: 'first' }), (error: unknown) => (error as { status: number }).status === 404);
});

test('长标题和特殊字符使用安全文件名，保留轮次与时间后缀', () => {
  const title = '标题'.repeat(60) + '/:*?<>|';
  const data = snapshot([thread('root', { title })]);
  const result = exportExchange(data, { taskId: 'root', exchangeId: 'second' });
  assert.doesNotMatch(result.filename, /[<>:"/\\|?*\x00-\x1f]/);
  assert.match(result.filename, /_第2轮_20261026-150100\.md$/);
});

test('实际reader在一次快照中导出指定轮次，不调用公开逐条读取且原库不变', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ctw-exchange-export-'));
  t.after(async () => {
    const rel = relative(tmpdir(), home);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(home, { recursive: true, force: true });
  });
  const statePath = join(home, 'state_5.sqlite'); const db = new DatabaseSync(statePath);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,thread_source TEXT,project_id TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '实际读取项目', 0);
  await mkdir(join(home, 'sessions'));
  const id = '11111111-1111-4111-8111-111111111111'; const log = join(home, 'sessions', `${id}.jsonl`);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '两轮任务', '', 'vscode', 'user', 'p', 0, 1792960000, 1792960001, log);
  db.close();
  await writeFile(log, [
    { type: 'session_meta', payload: { id, cwd: '', source: 'vscode' } },
    ...['first', 'second'].flatMap(name => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: name } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `实际需求 ${name}` }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: `实际输出 ${name}` }] } },
    ]),
  ].map(value => JSON.stringify(value)).join('\n'));
  const before = await readFile(statePath); const reader = native.createNativeReader(home);
  const catalog = await reader.catalog();
  reader.task = async () => { throw new Error('不能另取正文'); };
  reader.catalog = async () => { throw new Error('不能另取目录'); };
  assert.equal(typeof reader.exportExchange, 'function');
  const result = await reader.exportExchange({ taskId: id, exchangeId: 'second' });
  assert.equal(result.readAt, catalog.coverage.readAt);
  assert.match(result.markdown, /实际需求 second/); assert.match(result.markdown, /实际输出 second/);
  assert.doesNotMatch(result.markdown, /实际需求 first|实际输出 first/);
  assert.match(result.markdown, /^> \[!note\] 第 2 轮$/m);
  assert.deepEqual(await readFile(statePath), before);
});
