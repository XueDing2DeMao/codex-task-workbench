import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, copyFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { importHistoryPaths } from '../server/history/importer.ts';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const meta = (id = 'session-a', source: unknown = 'vscode', extra = {}) => ({ type: 'session_meta', payload: { id, source, ...extra } });
const message = (text: string, extra = {}) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...extra } });
async function fixture(t: any, rows: unknown[], tail = '') {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-history-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.jsonl');
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + tail);
  return { dir, path };
}

test('preserves raw physical records, rejects human inference, excludes protocol context', async t => {
  const rows = [meta(), message('<environment_context>pwd</environment_context>'), message('修改中文功能 <script>alert(1)</script>')];
  const { path } = await fixture(t, rows);
  const before = await readFile(path);
  const batch = await importHistoryPaths([path], 'project-a');
  const instructions = batch.records.filter(r => r.role === 'user' && r.kind === 'message');
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].attribution, 'unknown');
  assert.equal(instructions[0].sourceKind, 'root');
  assert.equal(instructions[0].line, 3);
  assert.equal(instructions[0].raw, JSON.stringify(rows[2]));
  assert.equal(instructions[0].text, '修改中文功能 <script>alert(1)</script>');
  assert.equal(batch.files[0].hash, digest(before));
  assert.equal(digest(await readFile(path)), digest(before));
});

test('IDs survive append, repeated import, relocation and retain repeated identical input events', async t => {
  const rows = [meta(), message('相同要求'), message('相同要求')];
  const { dir, path } = await fixture(t, rows);
  const first = await importHistoryPaths([path, path], 'project-a');
  const originals = first.records.filter(r => r.kind === 'message');
  assert.equal(originals.length, 2);
  assert.notEqual(originals[0].id, originals[1].id);
  await writeFile(path, rows.concat(message('追加要求')).map(row => JSON.stringify(row)).join('\n') + '\n');
  const appended = await importHistoryPaths([path], 'project-a');
  assert.deepEqual(appended.records.slice(0, first.records.length).map(r => r.id), first.records.map(r => r.id));
  const archived = join(dir, 'archived_sessions');
  await mkdir(archived);
  await copyFile(path, join(archived, 'moved.jsonl'));
  const moved = await importHistoryPaths([archived], 'project-a');
  assert.deepEqual(moved.records.map(r => r.id), appended.records.map(r => r.id));
  assert.ok(moved.records.every(r => r.archived));
});

test('preserves malformed and partial tails diagnostically, and skips auth/non-JSONL paths', async t => {
  const { dir, path } = await fixture(t, [meta(), message('完整指令')], '{"type":"response_item","payload":');
  const batch = await importHistoryPaths([dir], 'project-a');
  assert.equal(batch.records.filter(r => r.kind === 'message').length, 1);
  assert.ok(batch.diagnostics.some(d => d.code === 'incompleteTail'));
  await writeFile(join(dir, 'auth.json'), 'must-not-be-read');
  const denied = await importHistoryPaths([join(dir, 'auth.json')], 'project-a');
  assert.equal(denied.records.length, 0);
  assert.ok(denied.diagnostics.some(d => d.code === 'unsupportedFile'));
  assert.ok(batch.files.some(f => f.path === path));
});

test('file change confirmation requires explicit success and legacy patch calls are only attempts', async t => {
  const change = (status: string) => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'FileChange', id: status, status, changes: { 'file.txt': { type: 'add', content: '新增\n' } } } } });
  const rows = [meta(), change('completed'), change('failed'), change('unknown'), { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-a', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: attempt.txt\n+尝试\n*** End Patch' } }];
  const { path } = await fixture(t, rows);
  const batch = await importHistoryPaths([path], 'project-a');
  const changes = batch.records.flatMap(r => r.changes);
  assert.deepEqual(changes.map(c => c.status), ['confirmed', 'attempted', 'unknown', 'attempted']);
  assert.match(changes[0].diff, /新增/);
  assert.equal(changes[3].path, 'attempt.txt');
});

test('first metadata owns session; subagent author stays unknown; missing parent and unknown types remain visible', async t => {
  const rows = [meta('child', { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, { history_base: { thread_id: 'missing', end_ordinal_exclusive: 10 } }), meta('parent'), message('继承要求'), { type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }, message('子代理任务'), { type: 'future_format', payload: { note: 'keep' } }];
  const { path } = await fixture(t, rows);
  const batch = await importHistoryPaths([path], 'project-a');
  assert.ok(batch.records.every(r => r.sessionId === 'child'));
  assert.ok(batch.records.every(r => r.sourceKind === 'subagent'));
  assert.equal(batch.records.find(r => r.text === '继承要求')?.inherited, true);
  assert.equal(batch.records.find(r => r.text === '子代理任务')?.inherited, false);
  assert.ok(batch.records.filter(r => r.role === 'user').every(r => r.attribution === 'unknown'));
  assert.ok(batch.diagnostics.some(d => d.code === 'missingParent'));
  assert.ok(batch.diagnostics.some(d => d.code === 'unknownEvent'));
  assert.ok(batch.records.some(r => r.raw.includes('future_format')));
});

test('imports the ten verified local sample copies without mutation and preserves independent user/patch coverage', async t => {
  const manifestPath = process.env.WORKBENCH_SAMPLE_MANIFEST;
  if (!manifestPath) { t.skip('设置 WORKBENCH_SAMPLE_MANIFEST 后执行本机私有样本验证'); return; }
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const hashes = new Map<string, string>();
  for (const sample of manifest.samples) hashes.set(sample.copyPath, digest(await readFile(sample.copyPath)));
  const batch = await importHistoryPaths(manifest.samples.map((s: any) => s.copyPath), 'fixture-project');
  assert.equal(batch.files.length, 10);
  for (const sample of manifest.samples) {
    const records = batch.records.filter(r => r.filePath === sample.copyPath);
    assert.ok(records.length > 0, sample.sampleId);
    assert.ok(records.every(r => r.sessionId === sample.sessionId), sample.sampleId);
    assert.equal(records.filter(r => r.role === 'user' && r.kind === 'message').length, sample.stats.nonContextUserMessageCandidates, sample.sampleId);
    assert.equal(records.flatMap(r => r.changes).filter(c => c.status === 'confirmed').length, sample.stats.completedFileChangeEntries, sample.sampleId);
    assert.equal(digest(await readFile(sample.copyPath)), hashes.get(sample.copyPath), sample.sampleId);
    assert.equal(hashes.get(sample.copyPath), sample.sha256.toLowerCase(), sample.sampleId);
  }
  assert.ok(batch.records.some(r => r.kind === 'tool' && r.text));
  assert.ok(batch.diagnostics.some(d => d.code === 'missingParent'));
});

test('skips directory junctions instead of reading outside the selected history root', async t => {
  const { dir, path } = await fixture(t, [meta(), message('选定范围')]);
  const { dir: other } = await fixture(t, [meta('outside'), message('不应读取')]);
  await symlink(other, join(dir, 'escape'), 'junction');
  const batch = await importHistoryPaths([dir], 'project-a');
  assert.equal(batch.files.length, 1);
  assert.equal(batch.files[0].path, path);
  assert.ok(batch.diagnostics.some(d => d.code === 'symlinkSkipped'));
});

test('repeated explicit event IDs deduplicate while different events with identical wording remain distinct', async t => {
  const { path } = await fixture(t, [meta(), message('重复文字', { id: 'event-1' }), message('重复文字', { id: 'event-1' }), message('重复文字', { id: 'event-2' })]);
  const batch = await importHistoryPaths([path], 'project-a');
  assert.equal(batch.records.filter(r => r.kind === 'message').length, 2);
});

test('a source cycle is diagnosed without following it or inventing inherited records', async t => {
  const { dir } = await fixture(t, [meta('a', 'vscode', { history_base: { thread_id: 'b' } }), message('a内容')]);
  await writeFile(join(dir, 'b.jsonl'), [meta('b', 'vscode', { history_base: { thread_id: 'a' } }), message('b内容')].map(row => JSON.stringify(row)).join('\n') + '\n');
  const batch = await importHistoryPaths([dir], 'project-a');
  assert.equal(batch.records.filter(r => r.kind === 'message').length, 2);
  assert.ok(batch.diagnostics.some(d => d.code === 'historyCycle'));
});

test('explicit foreign thread origin is marked inherited without changing following unknown-origin messages', async t => {
  const foreign = { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'other', item: { type: 'CommandExecution', id: 'cmd', command: 'echo text', aggregated_output: 'text', status: 'completed', exit_code: 0 } } };
  const { path } = await fixture(t, [meta(), foreign, message('当前会话输入')]);
  const batch = await importHistoryPaths([path], 'project-a');
  assert.equal(batch.records.find(r => r.kind === 'tool')?.inherited, true);
  assert.equal(batch.records.find(r => r.text === '当前会话输入')?.inherited, false);
});

test('UTF-8 BOM retains byte-exact raw snapshot and matches the store hash contract', async t => {
  const { path } = await fixture(t, []);
  await writeFile(path, '\uFEFF' + JSON.stringify(meta()) + '\n' + JSON.stringify(message('带BOM指令')) + '\n');
  const batch = await importHistoryPaths([path], 'project-a');
  assert.equal(batch.records.length, 2);
  for (const record of batch.records) assert.equal(record.hash, digest(record.raw));
});
