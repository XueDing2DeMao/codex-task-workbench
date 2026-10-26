import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeSnapshot, searchNativeSnapshot } from '../server/native/service.ts';
import type { NativeThreadMeta } from '../server/native/catalog.ts';

const thread = (id: string, extra: Partial<NativeThreadMeta> = {}): NativeThreadMeta => ({ id, title: `任务 ${id}`, cwd: 'C:/project', projectId: 'project', archived: false, source: 'user', createdAt: '', updatedAt: '2026-10-26', ...extra });
const projects = [{ id: 'project', name: '材料项目', rootPath: 'C:/project' }, { id: 'empty-project', name: '空项目', rootPath: 'C:/empty' }];

test('每个原生线程只有一张卡，多轮需求及各自输出保持对应', () => {
  const snapshot = buildNativeSnapshot({ projects, threads: [thread('one')], warnings: [] }, {
    threads: [{ id: 'one', turns: [
      { id: 'turn-a', requirements: ['第一轮要求'], outputs: [{ id: 'a', text: '第一轮输出' }] },
      { id: 'turn-b', requirements: ['第二轮要求', '补充条件'], outputs: [{ id: 'b', text: '第二轮输出' }] },
    ] }], warnings: [],
  });
  assert.equal(snapshot.catalog.tasks.length, 1);
  assert.equal(snapshot.catalog.tasks[0].turnCount, 2);
  assert.equal(snapshot.details.get('one')?.exchanges[1].outputs[0].text, '第二轮输出');
  assert.equal(snapshot.catalog.projects[1].taskCount, 0);
  assert.equal(snapshot.catalog.coverage.requirements, 3);
  assert.equal('exchanges' in snapshot.catalog.tasks[0], false, '目录响应不附带全部正文');
});

test('归档及子任务不丢失，读取失败与真正空对话明确区分', () => {
  const snapshot = buildNativeSnapshot({ projects, threads: [thread('archived', { archived: true }), thread('child', { source: 'subagent', parentId: 'archived' }), thread('missing')], warnings: [] }, {
    threads: [{ id: 'archived', turns: [] }, { id: 'child', turns: [{ id: 'a', requirements: ['子任务要求'], outputs: [] }] }], warnings: [],
  });
  assert.equal(snapshot.catalog.tasks.length, 3);
  assert.equal(snapshot.catalog.coverage.archivedTasks, 1);
  assert.equal(snapshot.catalog.coverage.subagentTasks, 1);
  assert.equal(snapshot.catalog.coverage.emptyTasks, 1);
  assert.equal(snapshot.catalog.coverage.unavailableTasks, 1);
  assert.equal(snapshot.details.get('missing')?.availability, 'unavailable');
  assert.equal(snapshot.catalog.projects[0].taskCount, 2, '项目数量只统计用户发起的任务');
});

test('检索完整需求和输出末尾，不受卡片摘要或结果数量限制', () => {
  const many = Array.from({ length: 230 }, (_, index) => thread(String(index), { projectId: index % 2 ? 'empty-project' : 'project', archived: index > 180 }));
  const snapshot = buildNativeSnapshot({ projects, threads: many, warnings: [] }, { threads: many.map(item => ({ id: item.id, turns: [{ id: 't', requirements: ['普通需求'], outputs: [{ id: 'o', text: '中间内容'.repeat(500) + '非常靠后的完整结果关键词' }] }] })), warnings: [] });
  const result = searchNativeSnapshot(snapshot, '完整结果关键词');
  assert.equal(result.tasks.length, 230);
  assert.ok(result.tasks[0].matchExcerpt?.includes('完整结果关键词'));
  assert.equal(result.tasks[0].matchTurnId, 't');
  assert.equal(searchNativeSnapshot(snapshot, '材料项目 完整结果').tasks.length, 115, '项目名与正文可组合检索');
});

test('模糊搜索支持中文邻近跳字、多词、大小写，避免跨段拼凑', () => {
  const snapshot = buildNativeSnapshot({ projects, threads: [thread('a', { title: '登录页面布局' })], warnings: [] }, {
    threads: [{ id: 'a', turns: [{ id: 't', requirements: ['React 组件\n数据标准化输出'], outputs: [{ id: 'o', text: '布局统一' }] }] }], warnings: [],
  });
  assert.equal(searchNativeSnapshot(snapshot, '登页 react').tasks.length, 1);
  assert.equal(searchNativeSnapshot(snapshot, '数标').tasks.length, 1);
  assert.equal(searchNativeSnapshot(snapshot, '组数').tasks.length, 0);
  assert.equal(searchNativeSnapshot(snapshot, '不存在').tasks.length, 0);
});

test('审查任务从原始日志元数据恢复主任务关系，不计入项目任务数', () => {
  const snapshot = buildNativeSnapshot({ projects, threads: [thread('root'), thread('review', { source: 'guardian' })], warnings: [] }, {
    threads: [{ id: 'root', turns: [] }, { id: 'review', turns: [], metadata: { parentId: 'root' } }], warnings: [],
  });
  assert.equal(snapshot.catalog.tasks.find(t => t.id === 'review')?.parentId, 'root');
  assert.equal(snapshot.catalog.projects[0].taskCount, 1);
});

test('日志补回父任务后审查及多层子任务归入主项目，组合检索覆盖完整输出', () => {
  const archive = { id: 'native:archived', name: '已归档', rootPath: '' };
  const snapshot = buildNativeSnapshot({ projects: [...projects, archive], threads: [
    thread('review', { source: 'guardian', projectId: archive.id, archived: true }),
    thread('nested', { source: 'subagent', parentId: 'review', projectId: archive.id }),
    thread('root'),
  ], warnings: [] }, {
    threads: [{ id: 'root', turns: [] }, { id: 'review', metadata: { parentId: 'root' }, turns: [
      { id: 'review-turn', requirements: [], outputs: [{ id: 'r', text: '压缩回归证据' }] },
    ] }, { id: 'nested', turns: [{ id: 'child-turn', requirements: ['多层子任务正文'], outputs: [] }] }], warnings: [],
  });
  assert.equal(snapshot.details.get('review')?.projectId, 'project');
  assert.equal(snapshot.catalog.tasks.find(task => task.id === 'nested')?.projectId, 'project');
  const result = searchNativeSnapshot(snapshot, '材料项目 压缩回归');
  assert.deepEqual(result.tasks.map(task => task.id), ['review']);
  assert.equal(result.tasks[0].matchTurnId, 'review-turn');
  assert.deepEqual(searchNativeSnapshot(snapshot, '材料项目 多层子任务正文').tasks.map(task => task.id), ['nested']);
  assert.equal(snapshot.details.get('review')?.archived, true, '归类不能修改原始归档标志');
  assert.equal(snapshot.catalog.projects.find(project => project.id === archive.id)?.taskCount, 0);
});

test('归属对齐不猜测缺失或循环父任务，也不改变用户分支任务的项目', () => {
  const records = [thread('root'), thread('fork', { parentId: 'root', projectId: 'empty-project' }),
    thread('missing', { source: 'subagent', parentId: 'gone', projectId: 'empty-project' }),
    thread('loop-a', { source: 'guardian', parentId: 'loop-b', projectId: 'empty-project' }),
    thread('loop-b', { source: 'subagent', parentId: 'loop-a', projectId: 'empty-project' })];
  const snapshot = buildNativeSnapshot({ projects, threads: records, warnings: [] }, {
    threads: records.map(task => ({ id: task.id, turns: [] })), warnings: [],
  });
  for (const id of ['fork', 'missing', 'loop-a', 'loop-b']) assert.equal(snapshot.details.get(id)?.projectId, 'empty-project');
  assert.equal(snapshot.catalog.projects.find(project => project.id === 'empty-project')?.taskCount, 1);
});
