import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as native from '../server/native/service.ts';
import type { NativeSnapshot } from '../server/native/service.ts';
import type { NativeThreadMeta } from '../server/native/catalog.ts';
import type { NativeExchange, NativeExportRequest, NativeExportResult } from '../shared/native-contracts.ts';

const readAt = '2026-10-26T06:59:58.000Z';
const exportedAt = new Date('2026-10-26T07:00:00.000Z');
const projects = [{ id: 'p', name: '示例项目', rootPath: '' }, { id: 'q', name: '其他项目', rootPath: '' }, { id: 'native:archived', name: '已归档', rootPath: '' }];
const thread = (id: string, extra: Partial<NativeThreadMeta> = {}): NativeThreadMeta => ({ id, title: `任务 ${id}`, projectId: 'p', cwd: '', archived: false, source: 'user', createdAt: readAt, updatedAt: readAt, ...extra });
const turn = (id: string): NativeExchange => ({ id, requirements: [`需求 ${id}`], outputs: [{ id: `output-${id}`, text: `结果 ${id}` }] });
function snapshot(records: NativeThreadMeta[], turns = new Map<string, NativeExchange[]>(), unavailableIds: string[] = []) {
  return native.buildNativeSnapshot({ projects, threads: records, warnings: [] }, { threads: records.map(record => ({ id: record.id, turns: turns.get(record.id) ?? [turn(record.id)] })), warnings: [], unavailableIds }, readAt);
}
function exportSnapshot(data: NativeSnapshot, input: NativeExportRequest): NativeExportResult {
  const fn = (native as unknown as { exportNativeSnapshot?: (data: NativeSnapshot, input: NativeExportRequest, date: Date) => NativeExportResult }).exportNativeSnapshot;
  assert.equal(typeof fn, 'function', '服务层应提供完整快照导出能力');
  return fn!(data, input, exportedAt);
}
const whole = { projectId: 'p', scope: 'project', includeRelated: false } as const;
// 只移除新增的卡片容器，原文中的引用层级、缩进和空格必须保留。
const withoutCards = (markdown: string) => markdown.split('\n').map(line => line === '>' ? '' : line.startsWith('> ') ? line.slice(2) : line).join('\n');

test('项目导出覆盖超过36个任务、超过12轮的完整需求与最后输出，沿用目录顺序', () => {
  const records = Array.from({ length: 40 }, (_, i) => thread(`root-${String(i).padStart(2, '0')}`));
  records.push(thread('elsewhere', { projectId: 'q' }), thread('child', { source: 'subagent', parentId: 'root-00' }));
  const turns = new Map([['root-00', Array.from({ length: 15 }, (_, i) => turn(`long-${i}`))]]);
  const data = snapshot(records, turns); const result = exportSnapshot(data, whole);
  assert.equal(result.taskCount, 40);
  assert.equal(result.readAt, readAt);
  assert.equal((result.markdown.match(/^## 任务 \d+：/gm) ?? []).length, 40);
  assert.equal((result.markdown.match(/^> \[!note\] 第 \d+ 轮$/gm) ?? []).length, 54);
  assert.match(result.markdown, /需求 long-14/);
  assert.match(result.markdown, /结果 long-14/);
  assert.doesNotMatch(result.markdown, /结果 elsewhere|结果 child/);
  assert.ok(result.markdown.indexOf('## 任务 1：任务 root-00') < result.markdown.indexOf('## 任务 2：任务 root-01'));
  assert.match(result.markdown, /2026-10-26 15:00:00 \+08:00/);
  assert.match(result.markdown, /2026-10-26 14:59:58 \+08:00/);
  assert.match(result.filename, /^示例项目_全部任务_20261026-150000\.md$/);
});

test('选中一个或多个任务时去重、保持项目排序且不泄露未选任务', () => {
  const data = snapshot([thread('a'), thread('b'), thread('c')]);
  const one = exportSnapshot(data, { ...whole, scope: 'tasks', taskIds: ['b', 'b'] });
  assert.equal(one.taskCount, 1); assert.match(one.filename, /^任务 b_/);
  assert.match(one.markdown, /结果 b/); assert.doesNotMatch(one.markdown, /结果 a|结果 c/);
  const many = exportSnapshot(data, { ...whole, scope: 'tasks', taskIds: ['c', 'a'] });
  assert.equal(many.taskCount, 2); assert.match(many.filename, /所选2项任务/);
  assert.match(many.markdown, /导出范围：所选任务/);
  assert.ok(many.markdown.indexOf('## 任务 1：任务 a') < many.markdown.indexOf('## 任务 2：任务 c'));
  assert.doesNotMatch(many.markdown, /结果 b/);
});

test('Callout卡片兼容实时预览并完整保留代码、表格、引用、换行及全部需求/输出', () => {
  const request = '# 原始标题\n\n保持 **粗体** 与\n\n```ts\nconst x = `value`;\n\n  // 保留空行和缩进\n```\n\n| a | b |\n| --- | --- |\n| 中文 | 内容 |';
  const answer = '第一条结果\r\n\r\n[附件](./附件.md)\r\n\r\n> 引用\r\n>\r\n> > 嵌套引用\r\n\r\n- 列表\r\n  - 子项\r\n\r\n末尾空格  \r\n';
  const data = snapshot([thread('a')], new Map([['a', [{ id: 'turn-1', requirements: [request, '第二条需求'], outputs: [{ id: 'o1', text: answer }, { id: 'o2', text: '第二条结果' }] }, turn('next')]]]));
  const { markdown } = exportSnapshot(data, whole);
  const content = withoutCards(markdown);
  assert.ok(content.includes(request)); assert.ok(content.includes(answer));
  assert.ok(content.indexOf(request) < content.indexOf('第二条需求'));
  assert.ok(content.indexOf(answer) < content.indexOf('第二条结果'));
  assert.match(markdown, /需求 1/); assert.match(markdown, /需求 2/);
  assert.match(markdown, /输出 1/); assert.match(markdown, /输出 2/);
  assert.match(markdown, /^> \*\*需求\*\*$/m);
  assert.match(markdown, /\n> ---\n>\n> \*\*对应输出\*\*\n/);
  assert.match(markdown, /> 第二条结果\n\n---\n\n> \[!note\] 第 2 轮\n/);
  const cards = markdown.slice(markdown.indexOf('> [!note] 第 1 轮')).trimEnd().split('\n\n---\n\n');
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => card.split('\n').every(line => line === '>' || line.startsWith('> '))));
  assert.equal(exportSnapshot(data, { ...whole, scope: 'tasks', taskIds: ['a'] }).markdown.split('> [!note] 第 1 轮')[1], markdown.split('> [!note] 第 1 轮')[1]);
});

test('空任务、暂无最终输出和只有输出的轮次使用明确标记', () => {
  const data = snapshot([thread('empty'), thread('pending'), thread('output-only')], new Map([
    ['empty', []], ['pending', [{ id: 'p', requirements: ['尚待答复'], outputs: [] }]],
    ['output-only', [{ id: 'o', requirements: [], outputs: [{ id: 'o', text: '保留孤立输出' }] }]],
  ]));
  const { markdown } = exportSnapshot(data, whole);
  assert.match(markdown, /暂无需求与输出/); assert.match(markdown, /暂无对应输出/);
  assert.match(markdown, /本轮未记录用户需求/); assert.match(markdown, /保留孤立输出/);
});

test('所选任务读取失败应整体报告，未选失败不阻止正常导出', () => {
  const data = snapshot([thread('good'), thread('missing', { title: '正文缺失任务' })], new Map(), ['missing']);
  assert.throws(() => exportSnapshot(data, whole), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.match((error as Error).message, /正文缺失任务/); return true;
  });
  const result = exportSnapshot(data, { ...whole, scope: 'tasks', taskIds: ['good'] });
  assert.equal(result.taskCount, 1); assert.match(result.markdown, /结果 good/);
});

test('关联子任务与审查仅在勾选后归入主任务，多层父链不吞并用户分支', () => {
  const records = [thread('root'), thread('child', { source: 'subagent', parentId: 'root' }),
    thread('review', { source: 'guardian', parentId: 'child', archived: true }),
    thread('fork', { parentId: 'root' }), thread('fork-child', { source: 'subagent', parentId: 'fork' }),
    thread('orphan', { source: 'subagent', parentId: 'gone' }),
    thread('loop-a', { source: 'subagent', parentId: 'loop-b' }), thread('loop-b', { source: 'guardian', parentId: 'loop-a' })];
  const data = snapshot(records); const selected = { ...whole, scope: 'tasks' as const, taskIds: ['root'] };
  assert.doesNotMatch(exportSnapshot(data, selected).markdown, /结果 child|结果 review/);
  const result = exportSnapshot(data, { ...selected, includeRelated: true });
  assert.equal(result.taskCount, 1);
  assert.equal((result.markdown.match(/^## 任务 \d+：/gm) ?? []).length, 1);
  assert.match(result.markdown, /结果 child/); assert.match(result.markdown, /结果 review/);
  assert.match(result.markdown, /子任务与审查：2 个/); assert.match(result.markdown, /已归档/);
  assert.equal((result.markdown.split('### 关联子任务与审查')[1].match(/^> \[!note\] 第 1 轮$/gm) ?? []).length, 2);
  assert.doesNotMatch(result.markdown, /结果 fork|结果 orphan|结果 loop/);
  assert.ok(result.markdown.indexOf('结果 root') < result.markdown.indexOf('结果 child'));
  assert.equal(data.details.get('review')!.archived, true);
});

test('勾选关联任务后任何关联正文失败应报告；默认关闭时不受影响', () => {
  const data = snapshot([thread('root'), thread('review', { source: 'guardian', parentId: 'root', title: '未读审查' })], new Map(), ['review']);
  assert.equal(exportSnapshot(data, whole).taskCount, 1);
  assert.throws(() => exportSnapshot(data, { ...whole, includeRelated: true }), /未读审查/);
});

test('无效请求、空选择、跨项目、未知和非用户任务ID都拒绝，项目范围不可夹带选择', () => {
  const data = snapshot([thread('root'), thread('other', { projectId: 'q' }), thread('child', { source: 'subagent', parentId: 'root' })]);
  const invalid: unknown[] = [null, [], {}, { ...whole, includeRelated: 'yes' }, { ...whole, projectId: 2 },
    { ...whole, scope: 'all' }, { ...whole, taskIds: [] }, { ...whole, taskIds: ['root'] },
    { ...whole, scope: 'tasks' }, { ...whole, scope: 'tasks', taskIds: [] },
    ...[['other'], ['gone'], ['child'], [''], [null], 'root'].map(taskIds => ({ ...whole, scope: 'tasks', taskIds })),
    { ...whole, destination: 'C:/unexpected.md' }];
  for (const input of invalid) assert.throws(() => exportSnapshot(data, input as NativeExportRequest), (error: unknown) => (error as { status: number }).status === 400, JSON.stringify(input));
  assert.throws(() => exportSnapshot(data, { ...whole, projectId: 'deleted' }), (error: unknown) => (error as { status: number }).status === 404);
});

test('中文和特殊标题使用安全文件名与目录，归档及零任务项目也可导出', () => {
  const title = '中文 /\\:*?"<>|\n[标题](x)';
  const data = snapshot([thread('root', { title }), thread('old', { projectId: 'native:archived' })]);
  const { filename, markdown } = exportSnapshot(data, { ...whole, scope: 'tasks', taskIds: ['root'] });
  assert.doesNotMatch(filename, /[<>:"/\\|?*\x00-\x1f]/); assert.match(filename, /^中文/);
  assert.ok(filename.endsWith('.md')); assert.match(markdown, /\(#task-1\)/);
  assert.equal(exportSnapshot(data, { ...whole, projectId: 'native:archived' }).taskCount, 1);
  const empty = exportSnapshot(data, { ...whole, projectId: 'q' });
  assert.equal(empty.taskCount, 0); assert.match(empty.markdown, /暂无任务/);
});

test('生成只使用给定快照且不改变原对象或混入另一份新记录', () => {
  const old = snapshot([thread('old')]); const fresh = snapshot([thread('fresh')]);
  const before = JSON.stringify([...old.details]);
  const result = exportSnapshot(old, whole);
  assert.match(result.markdown, /结果 old/); assert.doesNotMatch(result.markdown, /结果 fresh/);
  assert.equal(result.readAt, old.catalog.coverage.readAt);
  assert.equal(JSON.stringify([...old.details]), before);
  assert.match(exportSnapshot(fresh, whole).markdown, /结果 fresh/);
});

test('实际读取器导出不依赖逐条公开请求且不修改原生库', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ctw-native-export-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const statePath = join(home, 'state_5.sqlite'); const db = new DatabaseSync(statePath);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,thread_source TEXT,project_id TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '真实读取测试', 0);
  await mkdir(join(home, 'sessions'));
  const id = '11111111-1111-4111-8111-111111111111'; const log = join(home, 'sessions', `${id}.jsonl`);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '测试任务', '', 'vscode', 'user', 'p', 0, 1792960000, 1792960001, log);
  db.close();
  await writeFile(log, [
    { type: 'session_meta', payload: { id, cwd: '', source: 'vscode' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实读取需求' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: '真实读取结果' }] } },
  ].map(value => JSON.stringify(value)).join('\n'));
  const before = await readFile(statePath); const reader = native.createNativeReader(home);
  assert.equal(typeof reader.exportMarkdown, 'function');
  reader.task = async () => { throw new Error('不得逐条读取'); };
  reader.catalog = async () => { throw new Error('不得另取目录'); };
  const result = await reader.exportMarkdown(whole);
  assert.equal(result.taskCount, 1); assert.match(result.markdown, /真实读取需求/); assert.match(result.markdown, /真实读取结果/);
  assert.deepEqual(await readFile(statePath), before);
});

test('实际读取器遇到损坏的最终消息投影时拒绝导出，不把丢失正文写成暂无输出', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ctw-native-export-corrupt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const statePath = join(home, 'state_5.sqlite'); const db = new DatabaseSync(statePath);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,thread_source TEXT,project_id TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '损坏投影测试', 0);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run('root', '损坏正文任务', '', 'vscode', 'user', 'p', 0, 1792960000, 1792960001, '');
  db.close();
  const historyPath = join(home, 'thread_history_1.sqlite'); const history = new DatabaseSync(historyPath);
  history.exec(`CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER);
    CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,started_at INTEGER,status TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT);`);
  history.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run('root', 100, 3);
  history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?)').run('root', 'turn', 0, 1790000000, 'completed');
  const insert = history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
  insert.run('root', 'turn', 'user', 1, 1790000000000, JSON.stringify({ content: [{ type: 'text', text: '已读取的需求' }] }), 'userMessage');
  insert.run('root', 'turn', 'final', 2, 1790000010000, '{broken', 'agentMessage');
  history.close();
  const before = await readFile(historyPath);
  const reader = native.createNativeReader(home);
  await assert.rejects(() => reader.exportMarkdown(whole), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as { code: string }).code, 'NATIVE_EXPORT_INCOMPLETE');
    assert.match((error as Error).message, /损坏正文任务/); return true;
  });
  assert.equal((await reader.task('root')).availability, 'unavailable');
  assert.deepEqual(await readFile(historyPath), before);
});

test('缺失的原始日志恢复后主动刷新重读正文，原读取器即可重新导出', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ctw-native-export-refresh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'sessions'));
  const id = '11111111-1111-4111-8111-111111111111'; const log = join(home, 'sessions', `${id}.jsonl`);
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,thread_source TEXT,project_id TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,rollout_path TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '刷新恢复测试', 0);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '暂缺日志任务', '', 'vscode', 'user', 'p', 0, 1792960000, 1792960001, log);
  db.close();
  const reader = native.createNativeReader(home);
  await assert.rejects(() => reader.exportMarkdown(whole), (error: unknown) => (error as { code: string }).code === 'NATIVE_EXPORT_INCOMPLETE');
  assert.equal((await reader.catalog()).coverage.unavailableTasks, 1);
  // 原始日志内容改变不一定更新数据库或 session_index；用户刷新必须强制重读。
  await writeFile(log, [
    { type: 'session_meta', payload: { id, cwd: '', source: 'vscode' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'recovered-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '恢复后的需求' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: '恢复后的输出' }] } },
  ].map(value => JSON.stringify(value)).join('\n'));
  assert.equal((await reader.catalog(true)).coverage.unavailableTasks, 0);
  const result = await reader.exportMarkdown(whole);
  assert.match(result.markdown, /恢复后的需求/); assert.match(result.markdown, /恢复后的输出/);
});
