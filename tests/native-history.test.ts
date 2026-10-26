import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { readNativeHistory } from '../server/native/history.ts';

const rootId = '11111111-1111-4111-8111-111111111111';
const aliasId = '22222222-2222-4222-8222-222222222222';
const meta = (id = rootId) => ({ type: 'session_meta', payload: { id, cwd: 'C:\\Projects\\app', source: 'vscode' } });
const serialize = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'native-history-'));
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(join(dir, 'archived_sessions'), { recursive: true });
  return dir;
}
function historyDb(dir: string) {
  const db = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT);
    CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER,first_user_item_id TEXT,final_agent_item_id TEXT,root_turn_id TEXT);
    CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER);`);
  return db;
}
function item(db: DatabaseSync, threadId: string, turnId: string, id: string, ordinal: number, payload: object) {
  const type = (payload as { type: string }).type;
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(threadId, turnId, id, ordinal, 1790000000000 + ordinal, JSON.stringify({ ...payload, id }), type);
}

test('压缩审查日志保留顶层父任务，优先显式父任务并兼容旧版嵌套来源', async () => {
  const dir = await fixture();
  try {
    const cases = [
      { id: rootId, parent_thread_id: 'user-root', source: { subagent: { other: 'guardian' } }, expected: 'user-root' },
      { id: aliasId, parent_thread_id: 'explicit-root', source: { subagent: { thread_spawn: { parent_thread_id: 'nested-root' } } }, expected: 'explicit-root' },
      { id: '33333333-3333-4333-8333-333333333333', source: { subagent: { thread_spawn: { parent_thread_id: 'nested-root' } } }, expected: 'nested-root' },
    ];
    for (const { expected: _, ...payload } of cases) {
      await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${payload.id}.jsonl.zst`), zstdCompressSync(Buffer.from(serialize([{ type: 'session_meta', payload }]))));
    }
    const result = await readNativeHistory(dir, cases.map(({ id }) => ({ id })));
    for (const item of cases) assert.equal(result.threads.find(thread => thread.id === item.id)?.metadata?.parentId, item.expected);
    assert.deepEqual(result.unavailableIds, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('原生正文按线程和轮次保留需求与所有final，忽略过程/工具，图片只用占位', async () => {
  const dir = await fixture();
  try {
    const db = historyDb(dir);
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?,?)').run(rootId, 'turn-1', 1, 'completed', 1790000000, 1790000010, 'u1', 'a2', null);
    item(db, rootId, 'turn-1', 'u1', 2, { type: 'userMessage', content: [{ type: 'text', text: '整理卡片' }, { type: 'localImage', path: 'C:\\secret\\example.png' }, { type: 'image', url: 'data:secretBase64' }] });
    item(db, rootId, 'turn-1', 'u2', 3, { type: 'userMessage', content: [{ type: 'text', text: '保持对齐' }] });
    item(db, rootId, 'turn-1', 'progress', 4, { type: 'agentMessage', phase: 'commentary', text: '过程不展示' });
    item(db, rootId, 'turn-1', 'a1', 5, { type: 'agentMessage', phase: 'final_answer', text: '第一份输出' });
    item(db, rootId, 'turn-1', 'a2', 6, { type: 'agentMessage', phase: 'final_answer', text: '第二份输出' });
    item(db, rootId, 'turn-1', 'tool', 7, { type: 'commandExecution', text: '工具不展示' });
    db.close();
    const before = await readFile(join(dir, 'thread_history_1.sqlite'));
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.equal(result.threads.length, 1);
    const turn = result.threads[0].turns[0];
    assert.equal(turn.requirements.length, 2);
    assert.match(turn.requirements[0], /example\.png/);
    assert.doesNotMatch(turn.requirements[0], /secretBase64|C:\\secret/);
    assert.deepEqual(turn.outputs.map(output => output.text), ['第一份输出', '第二份输出']);
    assert.deepEqual(await readFile(join(dir, 'thread_history_1.sqlite')), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('存储generation别名合并到session_meta的真实线程，不产生假任务且重复item去重', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}_${aliasId}.jsonl`), serialize([meta()]));
    const db = historyDb(dir);
    for (const id of [rootId, aliasId]) {
      db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?,?)').run(id, 'turn-1', 1, 'completed', 1790000000, 1790000010, 'u1', 'a1', null);
      item(db, id, 'turn-1', 'u1', 2, { type: 'userMessage', content: [{ type: 'text', text: '同一需求' }] });
      item(db, id, 'turn-1', 'a1', 3, { type: 'agentMessage', phase: 'final_answer', text: '同一输出' });
    }
    db.close();
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0].id, rootId);
    assert.equal(result.threads[0].turns[0].requirements.length, 1);
    assert.equal(result.threads[0].turns[0].outputs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('缺投影时流式读取JSONL.zst，按显式turn配对且不包含过程与工具', async () => {
  const dir = await fixture();
  try {
    const rows = [meta(), { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '压缩历史需求' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '过程' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', id: 'result-1', content: [{ type: 'output_text', text: '压缩历史结果' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }];
    await writeFile(join(dir, 'archived_sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl.zst`), zstdCompressSync(Buffer.from(serialize(rows))));
    const result = await readNativeHistory(dir, [{ id: rootId, archived: true }]);
    assert.equal(result.threads[0].turns[0].id, 't1');
    assert.deepEqual(result.threads[0].turns[0].requirements, ['压缩历史需求']);
    assert.deepEqual(result.threads[0].turns[0].outputs.map(output => output.text), ['压缩历史结果']);
    assert.equal(result.stats.fallbackThreads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('本机投影尚未包含追加尾部时只读取尾部并补齐同轮输出', async () => {
  const dir = await fixture();
  try {
    const prefix = serialize([meta(), { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }]);
    const suffix = serialize([{ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', id: 'tail-output', content: [{ type: 'output_text', text: '最新尾部输出' }] } }]);
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl`), prefix + suffix);
    const db = historyDb(dir);
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?,?)').run(rootId, 't1', 1, 'inProgress', 1790000000, null, 'u1', null, null);
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(rootId, Buffer.byteLength(prefix), 2);
    item(db, rootId, 't1', 'u1', 2, { type: 'userMessage', content: [{ type: 'text', text: '已投影需求' }] });
    db.close();
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.equal(result.threads[0].turns.length, 1);
    assert.deepEqual(result.threads[0].turns[0].requirements, ['已投影需求']);
    assert.deepEqual(result.threads[0].turns[0].outputs.map(output => output.text), ['最新尾部输出']);
    assert.equal(result.stats.fallbackFiles, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('无显式轮次的连续两次需求不与上一轮输出混配，双封装需求去重', async () => {
  const dir = await fixture();
  try {
    const rows = [meta(),
      { type: 'event_msg', payload: { type: 'user_message', message: '第一轮' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'final', message: '第一个输出' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '第二轮' } },
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'final', message: '第二个输出' } }];
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl`), serialize(rows));
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.deepEqual(result.threads[0].turns.map(turn => [turn.requirements, turn.outputs.map(output => output.text)]), [[['第一轮'], ['第一个输出']], [['第二轮'], ['第二个输出']]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('显式回滚从可见历史移除被回滚轮次，后续新需求独立配对', async () => {
  const dir = await fixture();
  try {
    const rows: unknown[] = [meta()];
    for (const id of ['t1', 't2']) rows.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }, { type: 'event_msg', payload: { type: 'user_message', message: id } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: `${id} result` } });
    rows.push({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } });
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl`), serialize(rows));
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.deepEqual(result.threads[0].turns.map(turn => turn.id), ['t1']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('缺失文件和损坏尾行明确标记不可完整读取，不能冒充成功空历史', async () => {
  const dir = await fixture();
  try {
    const missing = await readNativeHistory(dir, [{ id: rootId }]);
    assert.deepEqual(missing.unavailableIds, [rootId]);
    assert.ok(missing.warnings.length);
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl`), serialize([meta()]) + '{"type":');
    const broken = await readNativeHistory(dir, [{ id: rootId }]);
    assert.deepEqual(broken.unavailableIds, [rootId]);
    assert.ok(broken.warnings.some(warning => warning.includes('未能解析')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('投影确认已读取的空会话是真实空状态，压缩正文无需重复解压', async () => {
  const dir = await fixture();
  try {
    const text = serialize([meta()]);
    await writeFile(join(dir, 'sessions', `rollout-2026-10-01T00-00-00-${rootId}.jsonl.zst`), zstdCompressSync(Buffer.from(text)));
    const db = historyDb(dir);
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(rootId, Buffer.byteLength(text), 1);
    db.close();
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.equal(result.threads[0].turns.length, 0);
    assert.deepEqual(result.unavailableIds, []);
    assert.equal(result.stats.fallbackFiles, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('投影中的最终消息JSON损坏时保留已读需求，但整个线程标记不可完整读取', async () => {
  const dir = await fixture();
  try {
    const db = historyDb(dir);
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(rootId, 100, 3);
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?,?)').run(rootId, 'turn', 0, 'completed', 1790000000, 1790000010, 'user', 'final', null);
    item(db, rootId, 'turn', 'user', 1, { type: 'userMessage', content: [{ type: 'text', text: '已读取的需求' }] });
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(rootId, 'turn', 'final', 2, 1790000010000, '{broken', 'agentMessage');
    db.close();
    const result = await readNativeHistory(dir, [{ id: rootId }]);
    assert.deepEqual(result.threads[0].turns[0].requirements, ['已读取的需求']);
    assert.ok(result.warnings.some(warning => warning.includes('final')));
    assert.deepEqual(result.unavailableIds, [rootId], '损坏输出不能伪装成暂无输出的完整会话');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
