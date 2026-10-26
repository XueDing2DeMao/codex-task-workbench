import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { WorkbenchStore } from '../server/domain/store.ts';
import type { BackupData, Handoff, Project, ReceiptInput, SearchResult, SourceRecord, TaskContent, TaskDetail, TaskListItem } from '../shared/contracts.ts';

// 使用真实 HTTP、临时 SQLite 和显式标记的合成历史，不代表浏览器或人工效率验收。
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const contained = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ctw-workflow-'));
  const ownedRoot = await realpath(root);
  const tempParent = await realpath(tmpdir());
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    // 仅删除本次 mkdtemp 创建且再次验证为临时目录直接子目录的根。
    const currentRoot = await realpath(root);
    assert.equal(currentRoot, ownedRoot, '临时根真实路径不能改变');
    assert.equal(dirname(currentRoot), tempParent, '清理目标必须仍是系统临时目录的直接子目录');
    assert.ok(basename(currentRoot).startsWith('ctw-workflow-'));
    await rm(currentRoot, { recursive: true, force: true });
  });
  const history = join(root, 'history'); const webRoot = join(root, 'web'); const dataDirectory = join(root, 'data');
  await Promise.all([mkdir(history), mkdir(webRoot), mkdir(dataDirectory)]);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>HTTP workflow fixture</title>');
  const historyPath = join(history, 'workflow.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'synthetic-http-workflow', source: 'vscode', cwd: history } },
    { type: 'event_msg', timestamp: '2026-10-26T00:00:00Z', payload: { type: 'task_started', turn_id: 'fixture-turn' } },
    { type: 'response_item', timestamp: '2026-10-26T00:00:01Z', payload: { type: 'message', id: 'instruction-a', role: 'user', content: [{ type: 'input_text', text: '合成闭环要求：修改查询范围，旧指令仍可检索。' }] } },
    { type: 'response_item', timestamp: '2026-10-26T00:00:02Z', payload: { type: 'message', id: 'instruction-b', role: 'user', content: [{ type: 'input_text', text: '包外独立要求：保留另一个模块的配置。' }] } },
    { type: 'event_msg', timestamp: '2026-10-26T00:00:03Z', payload: { type: 'item_completed', thread_id: 'synthetic-http-workflow', turn_id: 'fixture-turn', item: { type: 'CommandExecution', id: 'command-result', command: 'synthetic-test-command', status: 'completed', exit_code: 0, aggregated_output: '合成执行证据：中文查询断言通过。' } } },
    { type: 'event_msg', timestamp: '2026-10-26T00:00:04Z', payload: { type: 'task_complete', turn_id: 'fixture-turn' } },
  ];
  const original = Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(historyPath, original);
  const baseline = await stat(historyPath);

  async function start(databasePath: string, directory: string) {
    assert.ok(contained(ownedRoot, databasePath), '测试数据库必须位于本次临时根');
    const store = new WorkbenchStore(databasePath);
    const server = createApp({ store, dataDirectory: directory, allowedRoots: [history], webRoot });
    closers.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(5000) });
    assert.equal(bootstrap.status, 200);
    const configuration = await bootstrap.json() as { csrfToken: string };
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    async function call<T = any>(path: string, method = 'GET', input?: unknown, expectedStatus = 200): Promise<T> {
      const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie!, Origin: base, 'Content-Type': 'application/json', 'X-Workbench-Token': configuration.csrfToken }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result).slice(0, 1500)}`);
      return result as T;
    }
    return { call };
  }
  const http = await start(join(dataDirectory, 'workbench.sqlite'), dataDirectory);
  const project = await http.call<Project>('/api/projects', 'POST', { name: '合成 HTTP 闭环测试', rootPath: history });
  await http.call('/api/sources/import', 'POST', { projectId: project.id, paths: [historyPath] });
  const instructions = await http.call<SearchResult>(`/api/search?scope=instructions&projectId=${project.id}&q=${encodeURIComponent('合成闭环要求')}`);
  const other = await http.call<SearchResult>(`/api/search?scope=instructions&projectId=${project.id}&q=${encodeURIComponent('包外独立要求')}`);
  const results = await http.call<SearchResult>(`/api/search?scope=results&projectId=${project.id}&q=${encodeURIComponent('合成执行证据')}`);
  assert.equal(instructions.total, 1); assert.equal(other.total, 1); assert.equal(results.total, 1);
  const instruction = instructions.items[0].source!; const output = results.items[0].source!;
  assert.equal(instruction.attribution, 'unknown');
  assert.equal(output.filePath, historyPath); assert.equal(output.line, 5);
  assert.equal(output.raw, JSON.stringify(records[4]), '原始执行记录保留完整 JSON 行');
  assert.equal(output.hash, hash(output.raw), '来源哈希可用原文独立核对');
  async function unchanged() {
    const after = await stat(historyPath);
    assert.equal(hash(await readFile(historyPath)), hash(original));
    assert.equal(after.mtimeMs, baseline.mtimeMs);
  }
  return { root: ownedRoot, history, historyPath, project, instruction, other: other.items[0].source!, output, start, unchanged, ...http };
}

const contentFor = (source: SourceRecord): TaskContent => ({ goal: '核对合成修改要求', requirements: ['旧指令仍可检索'], scope: '合成 HTTP 测试数据', nonGoals: '不执行真实历史命令', criteria: [{ id: 'AC-01', text: '中文查询能定位原始要求', required: true }], sourceIds: [source.id], conflicts: [] });

test('real HTTP closes organization, execution, human acceptance, version change and full restore workflow', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const organize = await f.call<Handoff>('/api/handoffs', 'POST', { purpose: 'organize', sourceIds: [f.instruction.id] });
  assert.equal(organize.taskId, null); assert.equal(organize.revisionId, null);
  const suggestion = '采纳建议：展示结果数量';
  const content = contentFor(f.instruction); content.requirements.push(suggestion);
  const returned = { projectId: f.project.id, title: '合成查询任务', content, handoffId: organize.id, adoptedSuggestions: [suggestion] };
  let detail = await f.call<TaskDetail>('/api/tasks', 'POST', returned);
  const taskId = detail.task.id;
  assert.equal(detail.task.currentRevisionId, null, '导入只创建草稿');
  assert.ok(detail.handoffs.some(handoff => handoff.id === organize.id), '原无任务整理包仍可回查');
  const adoptedSource = detail.draft!.content.sourceIds.find(id => id !== f.instruction.id); assert.ok(adoptedSource);
  const confirmedSuggestion = await f.call<SourceRecord>(`/api/records/${adoptedSource}`);
  assert.equal(confirmedSuggestion.attribution, 'human'); assert.match(confirmedSuggestion.raw, /用户采纳AI建议/);
  assert.equal((await f.call<SourceRecord>(`/api/records/${f.instruction.id}`)).attribution, 'unknown', '采纳建议不改写原作者');
  const repeated = await f.call<TaskDetail>('/api/tasks', 'POST', returned);
  assert.equal(repeated.task.id, taskId); assert.equal((await f.call<TaskListItem[]>('/api/tasks')).length, 1);
  await f.call('/api/tasks', 'POST', { ...returned, title: '相同包的不同返回' }, 409);

  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}/activate`, 'POST', { expectedVersion: detail.task.lockVersion });
  const v1 = detail.task.currentRevisionId!;
  const execute = await f.call<Handoff>('/api/handoffs', 'POST', { purpose: 'execute', taskId, revisionId: v1 });
  const receipt: ReceiptInput = { receiptId: 'fixture-receipt-v1', runId: 'fixture-run-v1', handoffId: execute.id, taskId, revisionId: v1, status: 'completed', summary: '合成证据已返回，等待人工核对', snapshotId: 'fixture-snapshot-v1', evidence: [{ id: 'fixture-evidence-v1', criterionId: 'AC-01', kind: 'source', sourceId: f.output.id, text: f.output.text, snapshotId: 'fixture-snapshot-v1' }] };
  await f.call('/api/receipts', 'POST', receipt);
  const beforeReview = (await f.call<TaskListItem[]>('/api/tasks'))[0];
  assert.equal(beforeReview.verification, 'unverified'); assert.equal(beforeReview.acceptance, 'pending');
  await f.call('/api/acceptances', 'POST', { taskId, revisionId: v1, snapshotId: receipt.snapshotId, decision: 'accepted', reason: '试图跳过核对' }, 400);
  await f.call('/api/assessments', 'POST', { taskId, revisionId: v1, criterionId: 'AC-01', snapshotId: receipt.snapshotId, evidenceIds: ['fixture-evidence-v1'], result: 'passed', reason: '已核对合成原始输出，退出码 0 与断言文字一致' });
  assert.equal((await f.call<TaskListItem[]>('/api/tasks'))[0].acceptance, 'pending');
  await f.call('/api/acceptances', 'POST', { taskId, revisionId: v1, snapshotId: receipt.snapshotId, decision: 'accepted', reason: '明确验收当前合成版本及快照' });
  assert.equal((await f.call<TaskListItem[]>('/api/tasks'))[0].acceptance, 'accepted');

  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}`);
  const v2Content = structuredClone(detail.revisions[0].content);
  v2Content.requirements.push('新增要求：可按项目筛选');
  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}/draft`, 'PUT', { content: v2Content, expectedVersion: detail.task.lockVersion });
  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}/activate`, 'POST', { expectedVersion: detail.task.lockVersion });
  const v2 = detail.task.currentRevisionId!; assert.notEqual(v2, v1);
  await f.call('/api/receipts', 'POST', receipt); // 旧包重复回传仍幂等地留在 v1。
  await f.call('/api/assessments', 'POST', { taskId, revisionId: v2, criterionId: 'AC-01', snapshotId: receipt.snapshotId, evidenceIds: ['fixture-evidence-v1'], result: 'passed', reason: '试图沿用旧证据' }, 400);
  const afterRevision = (await f.call<TaskListItem[]>('/api/tasks'))[0];
  assert.equal(afterRevision.verification, 'unverified'); assert.equal(afterRevision.acceptance, 'pending');
  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}`);
  assert.equal(detail.receipts.length, 1); assert.equal(detail.receipts[0].revisionId, v1); assert.equal(detail.acceptances[0].revisionId, v1);
  await f.call('/api/acceptances', 'POST', { taskId, revisionId: v1, snapshotId: receipt.snapshotId, decision: 'accepted', reason: '旧版本不得重新成为当前' }, 409);
  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}/archive`, 'POST', { archived: true, expectedVersion: detail.task.lockVersion });
  assert.equal((await f.call<TaskListItem[]>('/api/tasks')).length, 0);
  assert.equal((await f.call<TaskListItem[]>('/api/tasks?archived=true')).length, 1);
  detail = await f.call<TaskDetail>(`/api/tasks/${taskId}/archive`, 'POST', { archived: false, expectedVersion: detail.task.lockVersion });
  const exported = await f.call<{ markdown: string }>(`/api/tasks/${taskId}/export`);
  assert.match(exported.markdown, /版本 v1/); assert.match(exported.markdown, /版本 v2/); assert.match(exported.markdown, /合成执行证据/);

  const backup = await f.call<BackupData>('/api/backup');
  const restored = await f.call<{ restoredDirectory: string; restartRequired: boolean; tasks: number; records: number }>('/api/restore', 'POST', backup);
  assert.equal(restored.restartRequired, true); assert.equal(restored.tasks, 1);
  const restoredRoot = await realpath(restored.restoredDirectory);
  assert.ok(contained(f.root, restoredRoot), '恢复目录必须留在本次测试拥有的根内');
  const fresh = await f.start(join(restoredRoot, 'workbench.sqlite'), restoredRoot);
  assert.deepEqual(await fresh.call<TaskDetail>(`/api/tasks/${taskId}`), detail, '新服务中的完整任务、版本、证据和决定一致');
  const restoredBackup = await fresh.call<BackupData>('/api/backup');
  assert.deepEqual(restoredBackup.payload, backup.payload, '恢复包含全部关系与来源快照');
  assert.equal((await f.call<TaskListItem[]>('/api/tasks'))[0].currentRevisionId, v2, '恢复未替换原活动库');
  await f.unchanged();
});

test('HTTP organization import rejects wrong package and out-of-scope source references without creating tasks', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const handoff = await f.call<Handoff>('/api/handoffs', 'POST', { purpose: 'organize', sourceIds: [f.instruction.id] });
  const returned = { projectId: f.project.id, title: '坏包拒绝测试', handoffId: handoff.id, content: contentFor(f.instruction) };
  await f.call('/api/tasks', 'POST', { ...returned, handoffId: 'nonexistent-handoff' }, 404);
  await f.call('/api/tasks', 'POST', { ...returned, content: { ...returned.content, sourceIds: [] } }, 400);
  await f.call('/api/tasks', 'POST', { ...returned, content: { ...returned.content, sourceIds: [f.instruction.id, f.other.id] } }, 400);
  assert.equal((await f.call<TaskListItem[]>('/api/tasks')).length, 0, '坏包不能留下占位任务或有效版本');
  await f.unchanged();
});
