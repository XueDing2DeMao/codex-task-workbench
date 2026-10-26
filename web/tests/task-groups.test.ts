import test from 'node:test';
import assert from 'node:assert/strict';
import type { NativeSearchResult, NativeTaskSummary } from '../../shared/native-contracts.ts';
import { buildTaskHierarchy, groupSearchResults } from '../src/viewer/task-groups.ts';

const task = (id: string, extra: Partial<NativeTaskSummary> = {}): NativeTaskSummary => ({
  id, projectId: 'p', title: id, summary: '', createdAt: '', updatedAt: '', archived: false,
  source: 'user', turnCount: 1, outputCount: 1, availability: 'available', ...extra,
});
const result = (tasks: NativeTaskSummary[]): NativeSearchResult => ({ query: '命中', projects: [], tasks, total: tasks.length, readAt: '' });

test('只有用户任务进入卡片，跨层级子任务与审查任务回溯至对应主任务', () => {
  const root = task('root', { archived: true });
  const child = task('child', { source: 'subagent', parentId: root.id });
  const review = task('review', { source: 'guardian', parentId: child.id });
  const fork = task('user-fork', { parentId: root.id });
  const hierarchy = buildTaskHierarchy([review, child, root, fork]);
  assert.deepEqual(hierarchy.tasks.map(t => t.id), ['root', 'user-fork']);
  assert.equal(hierarchy.rootByTaskId.get('review')?.id, 'root');
  assert.equal(hierarchy.rootByTaskId.get('user-fork')?.id, 'user-fork');
  assert.deepEqual(new Set(hierarchy.childrenByRootId.get('root')?.map(t => t.id)), new Set(['child', 'review']));
  assert.deepEqual(hierarchy.unassigned, []);
});

test('缺失父任务、循环关系与未知来源不误挂用户任务，也不生成独立卡片', () => {
  const hierarchy = buildTaskHierarchy([task('root'), task('missing', { source: 'subagent', parentId: 'gone' }),
    task('a', { source: 'subagent', parentId: 'b' }), task('b', { source: 'guardian', parentId: 'a' }), task('unknown', { source: 'unknown' })]);
  assert.deepEqual(hierarchy.tasks.map(t => t.id), ['root']);
  assert.equal(hierarchy.unassigned.length, 4);
  assert.equal(hierarchy.rootByTaskId.has('a'), false);
});

test('只有子任务正文命中时，搜索呈现主任务卡并保留子任务和轮次定位', () => {
  const root = task('root');
  const child = task('child', { source: 'subagent', parentId: root.id });
  const hierarchy = buildTaskHierarchy([root, child]);
  const grouped = groupSearchResults(result([{ ...child, matchExcerpt: '子任务完整输出命中', matchTurnId: 'late-turn' }]), hierarchy);
  assert.equal(grouped.tasks.length, 1);
  assert.equal(grouped.tasks[0].id, 'root');
  assert.equal(grouped.tasks[0].source, 'user');
  assert.equal(grouped.tasks[0].matchChildId, 'child');
  assert.equal(grouped.tasks[0].matchTurnId, 'late-turn');
  assert.equal(grouped.tasks[0].matchExcerpt, '子任务完整输出命中');
  assert.equal(grouped.total, 1);
});

test('同一主任务多处命中只展示一次，优先定位主任务本身且项目计数采用用户口径', () => {
  const root = task('root');
  const child = task('child', { source: 'subagent', parentId: root.id });
  const review = task('review', { source: 'guardian', parentId: root.id });
  const other = task('other');
  const hierarchy = buildTaskHierarchy([root, child, review, other]);
  const grouped = groupSearchResults({ ...result([{ ...child, matchTurnId: 'child-turn' }, review, { ...root, matchTurnId: 'root-turn' }, other]),
    projects: [{ id: 'p', name: '项目', rootPath: '', description: '', taskCount: 4 }] }, hierarchy);
  assert.deepEqual(grouped.tasks.map(t => t.id), ['root', 'other']);
  assert.equal(grouped.tasks[0].matchChildId, undefined);
  assert.equal(grouped.tasks[0].matchTurnId, 'root-turn');
  assert.equal(grouped.projects[0].taskCount, 2);
  assert.equal(grouped.total, 3);
});
