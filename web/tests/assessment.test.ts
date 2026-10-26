import test from 'node:test';
import assert from 'node:assert/strict';
import type { Assessment, Receipt } from '../../shared/contracts.ts';
import { activeAssessments, criterionState, latestReceipt, readOrganizedDraft } from '../src/model.ts';

const judgment = (id: string, result: Assessment['result'], overrides: Partial<Assessment> = {}): Assessment => ({
  id, taskId: 'task-1', revisionId: 'v1', criterionId: 'AC-01', snapshotId: 'snapshot-A', evidenceIds: ['evidence-1'],
  result, reason: '已核对真实证据', actor: 'human', createdAt: '2026-10-26T01:00:00Z', ...overrides,
});

test('旧版本或不同快照的通过不能使当前验收项通过', () => {
  const records = [judgment('a1', 'passed')];
  assert.equal(criterionState(records, 'v2', 'snapshot-A', 'AC-01'), 'unverified');
  assert.equal(criterionState(records, 'v1', 'snapshot-B', 'AC-01'), 'unverified');
});

test('未明确替代的矛盾判断显示冲突', () => {
  assert.equal(criterionState([judgment('a1', 'failed'), judgment('a2', 'passed')], 'v1', 'snapshot-A', 'AC-01'), 'conflict');
});

test('明确替代旧失败后保留历史但按新判断展示', () => {
  assert.equal(criterionState([judgment('a1', 'failed'), judgment('a2', 'passed', { supersedes: ['a1'] })], 'v1', 'snapshot-A', 'AC-01'), 'passed');
});

test('跨版本的替代关系不移除本版本判断', () => {
  assert.equal(criterionState([judgment('a1', 'failed'), judgment('a2', 'passed', { revisionId: 'v2', supersedes: ['a1'] })], 'v1', 'snapshot-A', 'AC-01'), 'failed');
});

test('连续替代时只引用尚未被替代的判断', () => {
  const records = [judgment('a1', 'failed'), judgment('a2', 'passed', { supersedes: ['a1'] }), judgment('a3', 'failed', { supersedes: ['a2'] })];
  assert.deepEqual(activeAssessments(records, 'v1', 'snapshot-A', 'AC-01').map(item => item.id), ['a3']);
});

const receipt = (id: string, status: Receipt['status'], snapshotId = 'snapshot-A', createdAt = '2026-10-26T02:00:00Z'): Receipt => ({ receiptId: id, runId: id, handoffId: 'h1', taskId: 'task-1', revisionId: 'v1', status, summary: '', snapshotId, evidence: [], createdAt, hash: id });
test('更新的失败或完成回执使旧通过判断失效', () => {
  assert.equal(criterionState([judgment('a1', 'passed')], 'v1', 'snapshot-A', 'AC-01', [receipt('r1', 'failed')]), 'blocked');
  assert.equal(criterionState([judgment('a1', 'passed')], 'v1', 'snapshot-A', 'AC-01', [receipt('r1', 'completed')]), 'unverified');
  assert.equal(criterionState([judgment('a1', 'passed', { createdAt: '2026-10-26T03:00:00Z' })], 'v1', 'snapshot-A', 'AC-01', [receipt('r1', 'completed')]), 'passed');
});

test('快照 A、B、A 连续到达时最新目标仍为 A', () => {
  const records = [receipt('r1', 'completed', 'snapshot-A', '2026-10-26T01:00:00Z'), receipt('r2', 'completed', 'snapshot-B', '2026-10-26T02:00:00Z'), receipt('r3', 'completed', 'snapshot-A', '2026-10-26T03:00:00Z')];
  assert.equal(latestReceipt(records, 'v1')?.snapshotId, 'snapshot-A');
});

test('导入整理结果必须保留交接包身份，未采纳建议不进入要求', () => {
  const content = { goal: '目标', requirements: ['原始要求', '额外建议'], scope: '', nonGoals: '', criteria: [{ id: 'AC-01', text: '结果可核验', required: true }], sourceIds: ['s1'], conflicts: [] };
  assert.throws(() => readOrganizedDraft(JSON.stringify({ content, suggestions: [] })), /handoffId/);
  assert.throws(() => readOrganizedDraft(JSON.stringify({ content, handoffId: ' ', suggestions: [] })), /handoffId/);
  const parsed = readOrganizedDraft(JSON.stringify({ content, handoffId: 'handoff-1', suggestions: ['额外建议'] }));
  assert.equal(parsed.handoffId, 'handoff-1');
  assert.deepEqual(parsed.content.requirements, ['原始要求']);
});
