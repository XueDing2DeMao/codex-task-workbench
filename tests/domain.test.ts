import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import type { AssessmentInput, BackupData, HistoryBatch, ReceiptInput, SourceRecord, TaskContent } from '../shared/contracts.ts';
import { WorkbenchStore } from '../server/domain/store.ts';
import { digest } from '../server/domain/validation.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function source(projectId: string, id = 's1', text = '修改查询范围', options: Partial<SourceRecord> = {}): SourceRecord {
  const raw = JSON.stringify({ id, text });
  return { id, projectId, sessionId: 'session-1', turnId: `turn-${id}`, eventId: id,
    sequence: Number(id.replace(/\D/g, '')) || 1, timestamp: '2026-10-26T01:00:00.000Z',
    role: 'user', sourceKind: 'root', attribution: 'unknown', inherited: false, kind: 'message',
    text, raw, filePath: `C:/sample/${id}.jsonl`, line: 1, hash: hash(raw), archived: false, changes: [], ...options };
}
function batch(records: SourceRecord[]): HistoryBatch { return { records, diagnostics: [], files: [] }; }
function toolSource(projectId: string, id: string, output: string): SourceRecord {
  const raw = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
  return source(projectId, id, output, { raw, hash: hash(raw), role: 'tool', kind: 'tool' });
}
function content(sourceIds: string[] = []): TaskContent {
  return { goal: '可查询修改指令', requirements: ['只查询最近7天'], scope: '本地历史', nonGoals: '不执行历史命令',
    criteria: [{ id: 'AC-1', text: '查询修改返回原始指令', required: true }], sourceIds, conflicts: [] };
}
function setup() {
  const store = new WorkbenchStore(':memory:');
  const project = store.createProject({ name: '测试项目', rootPath: 'C:/sample' });
  store.importHistory(project.id, batch([source(project.id)]));
  return { store, project };
}
function activate(store: WorkbenchStore, projectId: string, title = '指令查询') {
  const draft = store.createTask({ projectId, title, content: content(['s1']) });
  return store.activateDraft(draft.task.id, draft.task.lockVersion);
}
function receipt(store: WorkbenchStore, taskId: string, overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  const task = store.getTask(taskId);
  const revisionId = task.task.currentRevisionId!;
  const handoff = store.createHandoff({ purpose: 'execute', taskId, revisionId });
  return { receiptId: 'receipt-1', runId: 'run-1', handoffId: handoff.id, taskId, revisionId,
    status: 'completed', summary: '执行结束，等待核对', snapshotId: 'snapshot-1',
    evidence: [{ id: 'evidence-1', criterionId: 'AC-1', kind: 'artifact', text: '测试输出快照：找到3条修改指令', snapshotId: 'snapshot-1' }], ...overrides };
}
function assessment(input: ReceiptInput, overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return { taskId: input.taskId, revisionId: input.revisionId, criterionId: 'AC-1', snapshotId: input.snapshotId,
    evidenceIds: [input.evidence[0].id], result: 'passed', reason: '人工核对快照与标准一致', ...overrides };
}
function accept(store: WorkbenchStore, input: ReceiptInput) {
  return store.acceptTask({ taskId: input.taskId, revisionId: input.revisionId, snapshotId: input.snapshotId,
    decision: 'accepted', reason: '逐项验收通过' });
}

test('历史事件幂等，但不同事件的相同文字均保留', () => {
  const { store, project } = setup();
  try {
    const duplicate = store.importHistory(project.id, batch([source(project.id)]));
    assert.equal(duplicate.inserted, 0); assert.equal(duplicate.skipped, 1);
    assert.equal(store.importHistory(project.id, batch([source(project.id, 's2')])).inserted, 1);
    assert.equal(store.search({ q: '修改', scope: 'instructions' }).total, 2);
    assert.equal(store.getRecord('s1').attribution, 'unknown');
  } finally { store.close(); }
});

test('来源ID冲突使整批回滚，来源原文不可覆盖', () => {
  const { store, project } = setup();
  try {
    assert.throws(() => store.importHistory(project.id, batch([source(project.id, 's2'), source(project.id, 's1', '改写历史')])), /冲突|conflict/i);
    assert.throws(() => store.getRecord('s2'));
    assert.equal(store.getRecord('s1').text, '修改查询范围');
  } finally { store.close(); }
});

test('人工来源判定独立保存，重新导入不会恢复成未知', () => {
  const { store, project } = setup();
  try {
    store.classifyRecord('s1', 'human');
    store.importHistory(project.id, batch([source(project.id)]));
    assert.equal(store.getRecord('s1').attribution, 'human');
    assert.equal(store.search({ q: '修改', attribution: 'human' }).total, 1);
  } finally { store.close(); }
});

test('来源引用不存在或跨项目时不能创建任务', () => {
  const { store, project } = setup();
  try {
    const other = store.createProject({ name: '另一个项目' });
    assert.throws(() => store.createTask({ projectId: project.id, title: '错误引用', content: content(['missing']) }));
    assert.throws(() => store.createTask({ projectId: other.id, title: '跨项目引用', content: content(['s1']) }));
    assert.equal(store.listTasks().length, 0);
  } finally { store.close(); }
});

test('人工建卡产生明确人工来源，初始卡仍是草稿', () => {
  const { store, project } = setup();
  try {
    const detail = store.createTask({ projectId: project.id, title: '人工补充', content: content() });
    assert.equal(detail.task.currentRevisionId, null);
    assert.equal(detail.revisions.length, 0);
    assert.equal(detail.draft!.content.sourceIds.length, 1);
    const input = store.getRecord(detail.draft!.content.sourceIds[0]);
    assert.equal(input.attribution, 'human'); assert.match(input.sessionId, /workbench/);
  } finally { store.close(); }
});

test('草稿可包含待解决冲突，但不能激活；旧并发版本不能覆盖', () => {
  const { store, project } = setup();
  try {
    const original = activate(store, project.id);
    const changed = content(['s1']); changed.conflicts = ['保留7天还是全部历史尚未确定'];
    const draft = store.saveDraft(original.task.id, { content: changed, expectedVersion: original.task.lockVersion });
    assert.equal(draft.task.currentRevisionId, original.task.currentRevisionId);
    assert.throws(() => store.activateDraft(draft.task.id, draft.task.lockVersion), /冲突|conflict/i);
    assert.throws(() => store.saveDraft(draft.task.id, { content: content(['s1']), expectedVersion: original.task.lockVersion }), /版本|conflict/i);
  } finally { store.close(); }
});

test('采纳建议保存用户采纳来源而不改写原始指令', () => {
  const { store, project } = setup();
  try {
    const detail = activate(store, project.id);
    const changed = content(['s1']); changed.requirements.push('增加项目筛选');
    const draft = store.saveDraft(detail.task.id, { content: changed, expectedVersion: detail.task.lockVersion, adoptedSuggestions: ['增加项目筛选'] });
    assert.equal(store.getRecord('s1').text, '修改查询范围');
    const adopted = draft.draft!.content.sourceIds.filter(id => id !== 's1').map(id => store.getRecord(id));
    assert.equal(adopted.length, 1); assert.equal(adopted[0].attribution, 'human');
    assert.match(adopted[0].text, /采纳|增加项目筛选/);
  } finally { store.close(); }
});

test('执行结束和导入快照不能自动产生验证或人工验收', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input);
    assert.equal(store.listTasks()[0].verification, 'unverified');
    assert.equal(store.getTask(task.task.id).acceptances.length, 0);
    assert.throws(() => accept(store, input));
    store.addAssessment(assessment(input));
    assert.equal(store.listTasks()[0].verification, 'passed');
    assert.equal(store.listTasks()[0].acceptance, 'pending');
    accept(store, input);
    assert.equal(store.listTasks()[0].acceptance, 'accepted');
  } finally { store.close(); }
});

test('v2不会继承v1的验证验收，旧回执仍绑定v1且多版本可搜索', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    const current = store.getTask(task.task.id); const changed = content(['s1']); changed.requirements = ['查询全部历史'];
    const draft = store.saveDraft(task.task.id, { content: changed, expectedVersion: current.task.lockVersion });
    const v2 = store.activateDraft(task.task.id, draft.task.lockVersion);
    assert.equal(v2.revisions.length, 2); assert.notEqual(v2.task.currentRevisionId, input.revisionId);
    assert.equal(v2.receipts[0].revisionId, input.revisionId);
    assert.equal(store.listTasks()[0].verification, 'unverified'); assert.equal(store.listTasks()[0].acceptance, 'pending');
    assert.throws(() => store.acceptTask({ ...input, revisionId: v2.task.currentRevisionId!, decision: 'accepted', reason: '旧结果不能代替新版' }));
    const oldHits = store.search({ q: '最近7天', scope: 'tasks' });
    assert.equal(oldHits.total, 1); assert.equal(oldHits.items[0].current, false);
    assert.equal(store.search({ q: '全部历史', scope: 'tasks' }).items[0].current, true);
  } finally { store.close(); }
});

test('同执行包允许多个run，重复回执幂等，同ID异内容冲突', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    const first = store.submitReceipt(input);
    assert.deepEqual(store.submitReceipt({ ...input }), first);
    assert.throws(() => store.submitReceipt({ ...input, summary: '被改写' }), /冲突|conflict/i);
    store.submitReceipt({ ...input, receiptId: 'receipt-2', runId: 'run-2', evidence: [{ ...input.evidence[0], id: 'evidence-2' }] });
    assert.equal(store.getTask(task.task.id).receipts.length, 2);
  } finally { store.close(); }
});

test('同run同任务版本的后续回执追加保存，不覆盖早先结果', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const first = receipt(store, task.task.id, { status: 'failed', summary: '第一轮检查失败' });
    store.submitReceipt(first);
    const followup = { ...first, receiptId: 'receipt-followup', status: 'completed' as const, summary: '同次执行的后续检查通过', evidence: [{ ...first.evidence[0], id: 'e-followup' }] };
    store.submitReceipt(followup);
    const saved = store.getTask(task.task.id).receipts;
    assert.equal(saved.length, 2); assert.equal(saved[0].status, 'failed'); assert.equal(saved[1].runId, first.runId);
    assert.equal(saved[1].status, 'completed'); assert.equal(store.getTask(task.task.id).acceptances.length, 0);
  } finally { store.close(); }
});

test('同run可绑定多个任务版本，证据不可串用', () => {
  const { store, project } = setup();
  try {
    const t1 = activate(store, project.id, '任务一'); const t2 = activate(store, project.id, '任务二');
    const r1 = receipt(store, t1.task.id); const r2 = receipt(store, t2.task.id, { receiptId: 'receipt-2', runId: r1.runId, evidence: [{ ...r1.evidence[0], id: 'evidence-2' }] });
    store.submitReceipt(r1); store.submitReceipt(r2);
    assert.equal(store.getTask(t2.task.id).receipts[0].runId, r1.runId);
    assert.throws(() => store.addAssessment(assessment(r2, { evidenceIds: [r1.evidence[0].id] })));
  } finally { store.close(); }
});

test('回执只允许真实交接包、匹配版本和已有验收项', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    assert.throws(() => store.submitReceipt({ ...input, handoffId: 'missing' }));
    assert.throws(() => store.submitReceipt({ ...input, evidence: [{ ...input.evidence[0], criterionId: 'unknown' }] }));
    assert.throws(() => store.submitReceipt({ ...input, evidence: [{ ...input.evidence[0], snapshotId: 'other' }] }));
    assert.equal(store.getTask(task.task.id).receipts.length, 0);
  } finally { store.close(); }
});

test('回执注入人工验收字段被拒绝且没有任何副作用', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    assert.throws(() => store.submitReceipt({ ...input, acceptance: 'accepted', actor: 'human' } as ReceiptInput));
    assert.equal(store.getTask(task.task.id).receipts.length, 0);
    assert.equal(store.getTask(task.task.id).acceptances.length, 0);
  } finally { store.close(); }
});

for (const status of ['failed', 'interrupted'] as const) {
  test(`${status}回执不能支撑通过判断`, () => {
    const { store, project } = setup();
    try {
      const task = activate(store, project.id); const input = receipt(store, task.task.id, { status });
      store.submitReceipt(input);
      assert.throws(() => store.addAssessment(assessment(input)));
      assert.throws(() => accept(store, input));
    } finally { store.close(); }
  });
}

test('agent_report和普通消息不能冒充直接验证证据', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0].kind = 'agent_report'; input.evidence[0].text = '全部测试通过';
    store.submitReceipt(input);
    assert.throws(() => store.addAssessment(assessment(input)));
    const second = { ...input, receiptId: 'r2', runId: 'run2', evidence: [{ ...input.evidence[0], id: 'e2', kind: 'source' as const, sourceId: 's1', text: store.getRecord('s1').text }] };
    assert.throws(() => store.submitReceipt(second));
  } finally { store.close(); }
});

test('直接工具证据保留来源，篡改文本或hash不能导入', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([toolSource(project.id, 'tool1', '3 tests passed; exit_code: 0')]));
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0] = { ...input.evidence[0], kind: 'source', sourceId: 'tool1', text: '虚构输出' };
    assert.throws(() => store.submitReceipt(input));
    input.evidence[0].text = store.getRecord('tool1').text; input.evidence[0].hash = 'invalid';
    assert.throws(() => store.submitReceipt(input));
    delete input.evidence[0].hash;
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
  } finally { store.close(); }
});

test('验证判断必须指向相同版本、验收项和快照', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input);
    assert.throws(() => store.addAssessment(assessment(input, { criterionId: 'AC-missing' })));
    assert.throws(() => store.addAssessment(assessment(input, { snapshotId: 'other-snapshot' })));
    assert.throws(() => store.addAssessment(assessment(input, { evidenceIds: [] })));
  } finally { store.close(); }
});

test('同对象矛盾判断阻断验收，明确取舍并给理由后才可通过', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input);
    const good = store.addAssessment(assessment(input));
    const bad = store.addAssessment(assessment(input, { result: 'failed', reason: '发现遗漏边界用例' }));
    assert.throws(() => accept(store, input));
    assert.throws(() => store.addAssessment(assessment(input, { supersedes: [good.id, bad.id], reason: '' })));
    store.addAssessment(assessment(input, { supersedes: [good.id, bad.id], reason: '重新核对，失败判断使用了错误的期望值，确认当前快照满足标准' }));
    accept(store, input); assert.equal(store.listTasks()[0].acceptance, 'accepted');
  } finally { store.close(); }
});

test('新快照或新失败运行不能沿用旧快照已验收状态', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    store.submitReceipt({ ...input, receiptId: 'r2', runId: 'run2', snapshotId: 'snapshot-2', evidence: [{ ...input.evidence[0], id: 'e2', snapshotId: 'snapshot-2' }] });
    assert.equal(store.listTasks()[0].verification, 'unverified');
    assert.equal(store.listTasks()[0].acceptance, 'pending');
    assert.equal(store.getTask(task.task.id).acceptances.length, 1);
  } finally { store.close(); }
});

test('归档不删除版本与链接，含归档查询能找到并恢复', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id);
    const archived = store.setArchived(task.task.id, true, task.task.lockVersion);
    assert.equal(store.listTasks().length, 0); assert.equal(store.listTasks({ archived: true }).length, 1);
    assert.equal(store.search({ q: '最近7天', scope: 'tasks' }).total, 0);
    assert.equal(store.search({ q: '最近7天', scope: 'tasks', archived: true }).total, 1);
    const restored = store.setArchived(task.task.id, false, archived.task.lockVersion);
    assert.equal(restored.task.currentRevisionId, task.task.currentRevisionId);
  } finally { store.close(); }
});

test('导出包含旧版本、原文、回执和验收而不依赖外部文件', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    const exported = store.exportTask(task.task.id);
    assert.match(exported.markdown, /修改查询范围/); assert.match(exported.markdown, /测试输出快照/);
    assert.equal(exported.json.acceptances.length, 1);
    assert.equal(exported.json.task.id, task.task.id);
  } finally { store.close(); }
});

test('备份含原始快照且在空库恢复全部关系，哈希错误被拒绝', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:'); const bad = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    const backup = store.createBackup();
    assert.match(JSON.stringify(backup), /测试输出快照/);
    assert.ok(JSON.stringify(backup).includes('修改查询范围'));
    assert.deepEqual(restored.restoreBackup(backup), { projects: 1, tasks: 1, records: 1 });
    assert.deepEqual(restored.getTask(task.task.id), store.getTask(task.task.id));
    assert.equal(restored.getRecord('s1').raw, store.getRecord('s1').raw);
    assert.throws(() => restored.restoreBackup(backup), /空|empty/i);
    assert.throws(() => bad.restoreBackup({ ...backup, hash: '0'.repeat(64) }), /hash|哈希|校验/i);
    assert.equal(bad.getOverview().tasks, 0);
  } finally { store.close(); restored.close(); bad.close(); }
});

test('SQLite重启后任务、来源和审计仍可读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-domain-'));
  const database = join(dir, 'state.sqlite'); let store = new WorkbenchStore(database);
  try {
    const project = store.createProject({ name: '重启持久化' });
    store.importHistory(project.id, batch([source(project.id)]));
    const task = activate(store, project.id); store.close(); store = new WorkbenchStore(database);
    assert.equal(store.getTask(task.task.id).revisions.length, 1);
    assert.ok(store.getTask(task.task.id).audit.length >= 2);
    assert.equal(store.getRecord('s1').text, '修改查询范围');
  } finally {
    store.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true });
  }
});

test('初始草稿能按正文和任务ID搜索，激活后不再重复展示草稿', () => {
  const { store, project } = setup();
  try {
    const created = store.createTask({ projectId: project.id, title: '初始任务', content: content(['s1']) });
    const hits = store.search({ q: '最近7天', scope: 'tasks' });
    assert.equal(hits.total, 1); assert.equal(hits.items[0].taskId, created.task.id); assert.equal(hits.items[0].current, false);
    assert.equal(store.search({ q: created.task.id, scope: 'tasks' }).total, 1);
    store.activateDraft(created.task.id, created.task.lockVersion);
    assert.equal(store.search({ q: '最近7天', scope: 'tasks' }).total, 1);
  } finally { store.close(); }
});

test('上下文按同项目同会话实际顺序而非稀疏sequence截取', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([source(project.id, 's2', '中间记录', { sequence: 100 }), source(project.id, 's3', '最后记录', { sequence: 9000 })]));
    const other = store.createProject({ name: '会话ID相同的另一项目' });
    store.importHistory(other.id, batch([source(other.id, 'other', '不可泄漏', { sequence: 50 })]));
    assert.deepEqual(store.getRecordContext('s2', 1, 1).map(s => s.id), ['s1','s2','s3']);
  } finally { store.close(); }
});

test('中文单字/两字及SQL通配符均按字面搜索，归档与分页不截断总数', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([source(project.id, 's2', '修改_100%完成', { archived: true }), source(project.id, 's3', '修改查询范围')]));
    assert.equal(store.search({ q: '改', limit: 1 }).total, 2);
    assert.equal(store.search({ q: '修改', archived: true }).total, 3);
    assert.equal(store.search({ q: '_100%', archived: true }).total, 1);
    assert.equal(store.search({ q: "' OR 1=1 --", archived: true }).total, 0);
    assert.equal(store.search({ q: '修改', limit: 1, offset: 1 }).items.length, 1);
  } finally { store.close(); }
});

test('导入后保留子代理与继承作者未知状态，不自动当成人类', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([source(project.id, 'sub', '修改子任务', { sourceKind: 'subagent', attribution: 'agent' }), source(project.id, 'inherited', '修改旧任务', { inherited: true })]));
    assert.equal(store.search({ q: '修改', attribution: 'human' }).total, 0);
    assert.equal(store.getRecord('sub').attribution, 'agent'); assert.equal(store.getRecord('inherited').attribution, 'unknown');
  } finally { store.close(); }
});

test('历史时间缺失保留为空，不用导入时间伪造；非空错误时间拒绝', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([source(project.id, 'no-time', '未知时间记录', { timestamp: '' })]));
    assert.equal(store.getRecord('no-time').timestamp, '');
    assert.throws(() => store.importHistory(project.id, batch([source(project.id, 'bad-time', '错误时间记录', { timestamp: 'not-a-date' })])));
  } finally { store.close(); }
});

test('明确失败的工具输出不能被completed摘要洗成通过', () => {
  const { store, project } = setup();
  try {
    store.importHistory(project.id, batch([toolSource(project.id, 'tool-fail', JSON.stringify({ exit_code: 1, output: 'tests failed' }))]));
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0] = { ...input.evidence[0], kind: 'source', sourceId: 'tool-fail', text: store.getRecord('tool-fail').text };
    store.submitReceipt(input); assert.throws(() => store.addAssessment(assessment(input)), /失败|failed/i);
  } finally { store.close(); }
});

test('新运行同快照的通过不能悄悄消除旧失败判断', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const first = receipt(store, task.task.id);
    store.submitReceipt(first); const failed = store.addAssessment(assessment(first, { result: 'failed', reason: '该快照有漏项' }));
    const second = { ...first, receiptId: 'r2', runId: 'run2', evidence: [{ ...first.evidence[0], id: 'e2' }] };
    store.submitReceipt(second); const passed = store.addAssessment(assessment(second));
    assert.throws(() => accept(store, second), /冲突|验证|标准/);
    store.addAssessment(assessment(second, { supersedes: [failed.id, passed.id], reason: '重新比对确认原失败源于错误期望，保留取舍说明' }));
    accept(store, second);
  } finally { store.close(); }
});

test('同快照收到新回执后旧通过判断先失效，人工观察需重新确认', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const first = receipt(store, task.task.id);
    store.submitReceipt(first); store.addAssessment(assessment(first)); accept(store, first);
    const second = { ...first, receiptId: 'r2', runId: 'run2', evidence: [{ ...first.evidence[0], id: 'e2', kind: 'observation' as const, text: '人工观察候选：界面显示3行' }] };
    store.submitReceipt(second);
    assert.equal(store.listTasks()[0].acceptance, 'pending'); assert.throws(() => accept(store, second));
    store.addAssessment(assessment(second, { reason: '本人在界面核对了3行与验收要求一致' })); accept(store, second);
  } finally { store.close(); }
});

test('失败的可选验收项也不能被必选通过隐藏', () => {
  const { store, project } = setup();
  try {
    const c = content(['s1']); c.criteria.push({ id: 'AC-2', text: '可选检查', required: false });
    const draft = store.createTask({ projectId: project.id, title: '含可选标准', content: c });
    const task = store.activateDraft(draft.task.id, draft.task.lockVersion); const input = receipt(store, task.task.id);
    input.evidence.push({ ...input.evidence[0], id: 'e2', criterionId: 'AC-2' });
    store.submitReceipt(input); store.addAssessment(assessment(input));
    store.addAssessment(assessment(input, { criterionId: 'AC-2', evidenceIds: ['e2'], result: 'failed', reason: '发现必须先核对的失败' }));
    assert.throws(() => accept(store, input));
  } finally { store.close(); }
});

test('重新计算校验和也不能让无效来源引用通过恢复，失败恢复整批回滚', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    activate(store, project.id); const backup = store.createBackup();
    const revision = backup.payload.revisions[0] as { content: TaskContent }; revision.content.sourceIds = ['missing-source'];
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(backup));
    assert.equal(restored.getOverview().projects, 0); assert.equal(restored.getOverview().records, 0);
    assert.equal(restored.restoreBackup(store.createBackup()).tasks, 1);
  } finally { store.close(); restored.close(); }
});

test('备份schema未知字段被拒绝，合法旧版验收和新版草稿都可恢复', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    const changed = content(['s1']); changed.requirements = ['全部历史'];
    let current = store.saveDraft(task.task.id, { content: changed, expectedVersion: task.task.lockVersion });
    current = store.activateDraft(task.task.id, current.task.lockVersion);
    store.saveDraft(task.task.id, { content: changed, expectedVersion: current.task.lockVersion });
    const bad = store.createBackup(); (bad.payload.tasks[0] as Record<string, unknown>).arbitraryPermission = true;
    const { hash: _hash, ...envelope } = bad; bad.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(bad)); assert.equal(restored.getOverview().tasks, 0);
    restored.restoreBackup(store.createBackup()); assert.deepEqual(restored.getTask(task.task.id), store.getTask(task.task.id));
  } finally { store.close(); restored.close(); }
});

test('工具调用参数即使被标记tool也不能冒充实际输出证据', () => {
  const { store, project } = setup();
  try {
    const args = JSON.stringify({ cmd: 'echo not-executed' });
    const raw = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'invocation', name: 'exec_command', arguments: args } });
    store.importHistory(project.id, batch([source(project.id, 'invocation', args, { raw, hash: hash(raw), role: 'tool', kind: 'tool' })]));
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0] = { ...input.evidence[0], kind: 'source', sourceId: 'invocation', text: args };
    assert.throws(() => store.submitReceipt(input), /结果|输出|证据/);
    assert.equal(store.getTask(task.task.id).acceptances.length, 0);
  } finally { store.close(); }
});

test('已完成执行的负路径日志不会因引用exit_code而被误判失败', () => {
  const { store, project } = setup();
  try {
    const output = '负路径断言通过；模拟 exit_code: 1；全套测试通过';
    const raw = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'completed', exit_code: 0, aggregated_output: output } } });
    store.importHistory(project.id, batch([source(project.id, 'negative-fixture', output, { raw, hash: hash(raw), kind: 'tool', role: 'tool' })]));
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0] = { ...input.evidence[0], kind: 'source', sourceId: 'negative-fixture', text: output };
    store.submitReceipt(input); store.addAssessment(assessment(input)); accept(store, input);
    assert.equal(store.listTasks()[0].acceptance, 'accepted');
  } finally { store.close(); }
});

test('公开备份哈希重算不能绕过agent_report不得支撑通过的规则', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id);
    input.evidence[0].kind = 'agent_report'; store.submitReceipt(input);
    store.addAssessment(assessment(input, { result: 'failed', reason: '只有代理自述，不能验证通过' }));
    const backup = store.createBackup(); (backup.payload.assessments[0] as { result: string }).result = 'passed';
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(backup), /证据|代理|通过/);
    assert.equal(restored.getOverview().tasks, 0);
  } finally { store.close(); restored.close(); }
});

test('恢复不能凭备份里actor=human的伪造记录绕过必选项验证', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id); store.submitReceipt(input);
    const backup = store.createBackup(); backup.payload.acceptances.push({ id: 'forged', taskId: input.taskId, revisionId: input.revisionId,
      snapshotId: input.snapshotId, decision: 'accepted', reason: '伪造', actor: 'human', createdAt: new Date(Date.now() + 60_000).toISOString() });
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(backup), /验证|标准|验收/);
    assert.equal(restored.getOverview().tasks, 0);
  } finally { store.close(); restored.close(); }
});

for (const invalidEvidence of ['failed', 'interrupted', 'source_failure'] as const) {
  test(`恢复重验${invalidEvidence}证据，重算哈希也不能伪造成通过`, () => {
    const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
    try {
      const task = activate(store, project.id); const input = receipt(store, task.task.id);
      if (invalidEvidence === 'source_failure') {
        const tool = toolSource(project.id, 'failed-output', JSON.stringify({ exit_code: 9, output: '失败' }));
        store.importHistory(project.id, batch([tool]));
        input.evidence[0] = { ...input.evidence[0], kind: 'source', sourceId: tool.id, text: tool.text };
      } else input.status = invalidEvidence;
      store.submitReceipt(input); store.addAssessment(assessment(input, { result: 'failed', reason: '保留实际失败判断' }));
      const backup = store.createBackup(); (backup.payload.assessments[0] as { result: string }).result = 'passed';
      const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
      assert.throws(() => restored.restoreBackup(backup), /失败|中断|通过/); assert.equal(restored.getOverview().tasks, 0);
    } finally { store.close(); restored.close(); }
  });
}

test('恢复按照时间保留已解决冲突与历史验收，不依赖备份数组顺序', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id); store.submitReceipt(input);
    const failure = store.addAssessment(assessment(input, { result: 'failed', reason: '最初判定有遗漏' }));
    const pass = store.addAssessment(assessment(input));
    store.addAssessment(assessment(input, { supersedes: [failure.id, pass.id], reason: '人工复核证据后撤销错误期望，保留旧判断' }));
    accept(store, input);
    const backup = store.createBackup(); backup.payload.assessments.reverse();
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    restored.restoreBackup(backup); assert.equal(restored.listTasks()[0].acceptance, 'accepted');
    assert.deepEqual(restored.getTask(task.task.id), store.getTask(task.task.id));
  } finally { store.close(); restored.close(); }
});

test('恢复拒绝重复替代已经被取代的判断', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const task = activate(store, project.id); const input = receipt(store, task.task.id); store.submitReceipt(input);
    const old = store.addAssessment(assessment(input, { result: 'failed', reason: '旧判断' }));
    store.addAssessment(assessment(input, { supersedes: [old.id], reason: '已核对原判断错误' }));
    const newest = store.addAssessment(assessment(input));
    const backup = store.createBackup();
    (backup.payload.assessments.find(value => (value as { id: string }).id === newest.id) as { supersedes: string[] }).supersedes = [old.id];
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(backup), /替代|当前判断/); assert.equal(restored.getOverview().tasks, 0);
  } finally { store.close(); restored.close(); }
});

test('无任务整理包回传创建草稿，保留来源并独立记录人工采纳建议', () => {
  const { store, project } = setup();
  try {
    const handoff = store.createHandoff({ purpose: 'organize', sourceIds: ['s1'] });
    assert.match(handoff.instruction, /handoffId/); assert.match(handoff.instruction, /suggestions/);
    const task = store.createTask({ projectId: project.id, title: '整理后的卡片', handoffId: handoff.id, content: content(['s1']), adoptedSuggestions: ['人工选中建议：按项目过滤'] });
    assert.equal(task.task.currentRevisionId, null); assert.equal(task.draft!.content.sourceIds[0], 's1');
    const adopted = store.getRecord(task.draft!.content.sourceIds[1]);
    assert.equal(adopted.attribution, 'human'); assert.match(adopted.text, /人工选中建议/);
    assert.ok(task.audit.some(event => event.detail.includes(handoff.id)));
    assert.ok(task.handoffs.some(item => item.id === handoff.id));
  } finally { store.close(); }
});

test('无任务整理包拒绝跨项目、漏来源和有任务的交接包，失败不留卡片', () => {
  const { store, project } = setup();
  try {
    const other = store.createProject({ name: '另一个项目' });
    const handoff = store.createHandoff({ purpose: 'organize', sourceIds: ['s1'] });
    store.importHistory(project.id, batch([source(project.id, 'outside-package', '同项目但未选择的指令')]));
    assert.throws(() => store.createTask({ projectId: project.id, title: '包外来源', handoffId: handoff.id, content: content(['s1', 'outside-package']) }), (error: unknown) => (error as { code: string }).code === 'SOURCE_SCOPE_MISMATCH');
    assert.throws(() => store.createTask({ projectId: other.id, title: '跨项目', handoffId: handoff.id, content: content() }));
    assert.throws(() => store.createTask({ projectId: project.id, title: '漏来源', handoffId: handoff.id, content: content() }));
    assert.equal(store.listTasks().length, 0);
    const task = activate(store, project.id);
    for (const purpose of ['organize', 'execute'] as const) {
      const bound = store.createHandoff({ purpose, taskId: task.task.id });
      assert.throws(() => store.createTask({ projectId: project.id, title: '不允许重建任务', handoffId: bound.id, content: content(['s1']) }));
    }
    assert.equal(store.listTasks().length, 1);
  } finally { store.close(); }
});

test('整理包重复建卡及备份恢复后均幂等，异内容重用返回409', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const handoff = store.createHandoff({ purpose: 'organize', sourceIds: ['s1'] });
    const input = { projectId: project.id, title: '一次整理只建一张卡', handoffId: handoff.id, content: content(['s1']), adoptedSuggestions: ['人工采纳建议'] };
    const first = store.createTask(input); const before = store.createBackup().payload;
    assert.deepEqual(store.createTask(input), first); assert.deepEqual(store.createBackup().payload, before);
    assert.throws(() => store.createTask({ ...input, title: '异内容' }), (error: unknown) => (error as { status: number }).status === 409);
    restored.restoreBackup(store.createBackup()); assert.deepEqual(restored.createTask(input), first); assert.equal(restored.listTasks().length, 1);
  } finally { store.close(); restored.close(); }
});

test('恢复检查整理包消费映射唯一且不能指向其他任务', () => {
  const { store, project } = setup(); const restored = new WorkbenchStore(':memory:');
  try {
    const handoff = store.createHandoff({ purpose: 'organize', sourceIds: ['s1'] });
    store.createTask({ projectId: project.id, title: '源任务', handoffId: handoff.id, content: content(['s1']) });
    const other = store.createTask({ projectId: project.id, title: '其他任务', content: content(['s1']) });
    const backup = store.createBackup();
    const imported = backup.payload.audit.find(value => (value as { action: string }).action === 'organization_imported') as Record<string, unknown>;
    backup.payload.audit.push({ ...imported, id: 'duplicate-import-map', taskId: other.task.id });
    const { hash: _hash, ...envelope } = backup; backup.hash = digest(envelope);
    assert.throws(() => restored.restoreBackup(backup), /整理|重复|导入/); assert.equal(restored.getOverview().tasks, 0);
  } finally { store.close(); restored.close(); }
});

test('绑定任务整理包回传重复保存不增加版本，来源不得丢弃或套用无任务包', () => {
  const { store, project } = setup();
  try {
    const task = activate(store, project.id); const handoff = store.createHandoff({ purpose: 'organize', taskId: task.task.id });
    const input = { content: content(['s1']), expectedVersion: task.task.lockVersion, handoffId: handoff.id, adoptedSuggestions: ['人工采纳建议'] };
    const first = store.saveDraft(task.task.id, input); const before = store.createBackup().payload;
    assert.deepEqual(store.saveDraft(task.task.id, input), first); assert.deepEqual(store.createBackup().payload, before);
    const empty = store.createHandoff({ purpose: 'organize', sourceIds: ['s1'] });
    assert.throws(() => store.saveDraft(task.task.id, { content: content(['s1']), expectedVersion: first.task.lockVersion, handoffId: empty.id }));
    const next = store.createHandoff({ purpose: 'organize', taskId: task.task.id });
    assert.throws(() => store.saveDraft(task.task.id, { content: content(), expectedVersion: first.task.lockVersion, handoffId: next.id }));
  } finally { store.close(); }
});
