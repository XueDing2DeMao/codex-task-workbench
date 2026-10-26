import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project, SourceRecord, TaskDetail } from '../../shared/contracts.ts';
import { buildViewerProjects, filterViewerTasks, loadViewerData, matchesFuzzy } from '../src/viewer-data.ts';
import { api } from '../src/api.ts';

const project: Project = { id: 'p1', name: '官网改版', rootPath: 'C:\\work\\website', createdAt: '2026-10-26T01:00:00Z' };
const message = (id: string, role: string, text: string, overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  id, projectId: 'p1', sessionId: 'session1', turnId: 'turn1', eventId: id, sequence: 1,
  timestamp: '2026-10-26T01:00:00Z', role, sourceKind: 'root', attribution: role === 'user' ? 'human' : 'agent',
  inherited: false, kind: 'message', text, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', phase: role === 'assistant' ? 'final_answer' : undefined } }),
  filePath: '', line: 1, hash: id, archived: false, changes: [], ...overrides,
});

test('历史需求只配对同项目同会话同轮次的最终输出，排除过程与工具消息', () => {
  const records = [message('u1', 'user', '优化登录页面'), message('a1', 'assistant', '已完成登录页面', { sequence: 4 }),
    message('progress', 'assistant', '正在处理', { sequence: 2, raw: JSON.stringify({ payload: { phase: 'commentary' } }) }),
    message('tool', 'tool', 'secret tool log', { sequence: 3, kind: 'tool' }),
    message('other-turn', 'assistant', '其他轮输出', { sequence: 5, turnId: 'turn2' }),
    message('other-project', 'assistant', '其他项目输出', { projectId: 'p2' }),
    message('other-session', 'assistant', '其他会话输出', { sessionId: 'session2' })];
  const task = buildViewerProjects([project], [], records)[0].tasks[0];
  assert.deepEqual(task.requirements, ['优化登录页面']);
  assert.deepEqual(task.outputs.map(output => output.text), ['已完成登录页面']);
  assert.equal(task.source, 'history');
});

test('子代理继承内容、上下文、人工建卡来源不会产生重复的历史任务', () => {
  const records = [message('sub', 'user', '继承需求', { sourceKind: 'subagent', inherited: true }),
    message('context', 'user', '环境说明', { kind: 'context' }),
    message('manual', 'user', '人工创建任务', { sessionId: 'workbench-human-input' }),
    message('inherited', 'user', '重复的父级消息', { inherited: true }),
    message('agent', 'user', '代理派发消息', { attribution: 'agent' })];
  assert.equal(buildViewerProjects([project], [], records)[0].tasks.length, 0);
});

test('同轮 event 和 response 结果去重；item_completed 的 final_answer 可展示', () => {
  const records = [message('u', 'user', '需求'), message('event', 'assistant', '最终输出', { sequence: 2,
    raw: JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer' } } }) }),
    message('response', 'assistant', '最终输出', { sequence: 3 })];
  assert.equal(buildViewerProjects([project], [], records)[0].tasks[0].outputs.length, 1);
});

test('没有明确 final 的记录显示空输出，不能把 assistant 过程文字当结果', () => {
  const records = [message('u', 'user', '需求'), message('ambiguous', 'assistant', '可能仍在处理', { sequence: 2, raw: '{}' })];
  assert.deepEqual(buildViewerProjects([project], [], records)[0].tasks[0].outputs, []);
});

test('缺少轮次编号时按用户消息划分，前后需求输出不会串联', () => {
  const records = [message('u1', 'user', '第一个需求', { turnId: '', sequence: 1 }),
    message('a1', 'assistant', '第一个结果', { turnId: '', sequence: 2 }),
    message('u2', 'user', '第二个需求', { turnId: '', sequence: 3 }),
    message('a2', 'assistant', '第二个结果', { turnId: '', sequence: 4 })];
  const tasks = buildViewerProjects([project], [], records)[0].tasks;
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.find(task => task.requirements[0] === '第一个需求')?.outputs.map(output => output.text), ['第一个结果']);
  assert.deepEqual(tasks.find(task => task.requirements[0] === '第二个需求')?.outputs.map(output => output.text), ['第二个结果']);
});

const unnumberedUser = (id: string, sequence: number, representation: 'event' | 'response', overrides: Partial<SourceRecord> = {}) => message(id, 'user', '重复文字需求', {
  turnId: '', sequence, raw: JSON.stringify(representation === 'event'
    ? { type: 'event_msg', payload: { type: 'user_message', message: '重复文字需求' } }
    : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重复文字需求' }] } }), ...overrides,
});

test('无轮次的同一用户消息以相邻 event 和 response 双封装出现时只展示一张卡', () => {
  const records = [unnumberedUser('event-user', 1, 'event'), unnumberedUser('response-user', 2, 'response'),
    message('final', 'assistant', '已完成', { turnId: '', sequence: 3 })];
  const tasks = buildViewerProjects([project], [], records)[0].tasks;
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].requirements, ['重复文字需求']);
  assert.deepEqual(tasks[0].outputs.map(output => output.text), ['已完成']);
});

test('无轮次的合法重复发送不因同文字而合并', () => {
  const cases = [
    [unnumberedUser('first', 1, 'event'), unnumberedUser('second', 2, 'event')],
    [unnumberedUser('first', 1, 'event'), unnumberedUser('second', 2, 'response', { timestamp: '2026-10-26T01:00:00.001Z' })],
    [unnumberedUser('first', 1, 'event'), message('between', 'tool', '执行日志', { sequence: 2, turnId: '', kind: 'tool' }), unnumberedUser('second', 3, 'response')],
    [unnumberedUser('first', 1, 'event', { raw: JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message_id: 'message-1' } }) }),
      unnumberedUser('second', 2, 'response', { raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'message-2' } }) })],
  ];
  for (const records of cases) assert.equal(buildViewerProjects([project], [], records)[0].tasks.length, 2);
});

test('两次合法重复发送各自的 event/response 配对不会全部合并成一张', () => {
  const records = [unnumberedUser('event1', 1, 'event'), unnumberedUser('response1', 2, 'response'),
    unnumberedUser('event2', 3, 'event'), unnumberedUser('response2', 4, 'response')];
  assert.equal(buildViewerProjects([project], [], records)[0].tasks.length, 2);
});

const detail = (): TaskDetail => ({
  task: { id: 'task1', projectId: 'p1', title: '登录优化', currentRevisionId: 'v2', lockVersion: 2, archived: false, createdAt: '', updatedAt: '2026-10-26T02:00:00Z' },
  revisions: ['v1', 'v2'].map((id, index) => ({ id, taskId: 'task1', number: index + 1, createdAt: '', parentId: null,
    content: { goal: id === 'v2' ? '当前需求' : '旧需求', requirements: ['输入框对齐'], scope: '', nonGoals: '', criteria: [], conflicts: [], sourceIds: ['linked-source'] } })),
  draft: null, handoffs: [], receipts: ['v1', 'v2'].map(revisionId => ({ receiptId: revisionId, runId: revisionId, handoffId: '', taskId: 'task1', revisionId,
    status: 'completed', summary: revisionId === 'v2' ? '当前结果' : '旧结果', snapshotId: '', evidence: [], createdAt: '2026-10-26T02:00:00Z', hash: revisionId })),
  assessments: [], acceptances: [], audit: [],
});

test('真实任务采用当前版本与对应回执，已关联来源不再生成重复历史卡片', () => {
  const tasks = buildViewerProjects([project], [detail()], [message('linked-source', 'user', '旧来源需求')])[0].tasks;
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].requirements, ['当前需求', '输入框对齐']);
  assert.deepEqual(tasks[0].outputs.map(output => output.text), ['当前结果']);
});

test('既有任务的非目标、验收要求和待明确约束都保留为只读需求文字', () => {
  const data = detail(); const content = data.revisions[1].content;
  content.nonGoals = '不调整后端接口';
  content.criteria = [{ id: 'AC-1', text: '输入框对齐', required: true }, { id: 'AC-2', text: '增加键盘提示', required: false }];
  content.conflicts = ['移动端宽度待确认'];
  const task = buildViewerProjects([project], [data], [])[0].tasks[0];
  assert.deepEqual(task.requirements, ['当前需求', '输入框对齐', '不包含：不调整后端接口', '验收要求：输入框对齐', '验收要求（可选）：增加键盘提示', '待明确：移动端宽度待确认']);
  assert.equal(filterViewerTasks([task], '后端接口').length, 1);
});

test('无当前版本时展示草稿，但绝不附带旧版本回执', () => {
  const data = detail();
  data.task.currentRevisionId = null;
  data.draft = { taskId: 'task1', basedOn: null, updatedAt: '', content: { goal: '草稿需求', requirements: [], scope: '', nonGoals: '', criteria: [], conflicts: [], sourceIds: [] } };
  const task = buildViewerProjects([project], [data], [])[0].tasks[0];
  assert.equal(task.contentLabel, '草稿内容');
  assert.deepEqual(task.requirements, ['草稿需求']);
  assert.deepEqual(task.outputs, []);
});

test('模糊搜索支持中文片段、近距离跳字、多个关键词及英文大小写', () => {
  assert.equal(matchesFuzzy('登优化', '登录页面优化'), true);
  assert.equal(matchesFuzzy('登录 对齐', '登录页面优化', '输入框与按钮对齐'), true);
  assert.equal(matchesFuzzy('LOGIN', 'Login page'), true);
  assert.equal(matchesFuzzy(' ｌｏｇｉｎ ', 'login page'), true);
  assert.equal(matchesFuzzy('', '任意内容'), true);
  assert.equal(matchesFuzzy('导出 安全', '导出页面'), false);
});

test('短查询不会跨段落或在很长的段落中无限跳字误匹配', () => {
  assert.equal(matchesFuzzy('登录', '登' + '中'.repeat(100) + '录'), false);
  assert.equal(matchesFuzzy('登录', '登山的记录\n录入资料'), false);
  assert.equal(matchesFuzzy('abc', 'a' + 'x'.repeat(100) + 'bc'), false);
  assert.equal(matchesFuzzy('az', 'a'.repeat(500_000)), false);
  assert.equal(matchesFuzzy('az', 'a'.repeat(500_000) + 'z'), true);
});

test('任务检索覆盖需求、输出，空查询保留全部，匹配完整标题优先', () => {
  const tasks = buildViewerProjects([project], [], [message('u1', 'user', '布局整理'), message('a1', 'assistant', '补充按钮焦点样式', { sequence: 2 }),
    message('u2', 'user', '按钮', { turnId: 'turn2', sequence: 3 })])[0].tasks;
  assert.equal(filterViewerTasks(tasks, '焦点').length, 1);
  assert.equal(filterViewerTasks(tasks, '按钮')[0].title, '按钮');
  assert.equal(filterViewerTasks(tasks, '无关词').length, 0);
  assert.equal(filterViewerTasks(tasks, '').length, 2);
});

test('读取指令和会话的后续页，并保留位于第二页的最终输出', async () => {
  const original = { bootstrap: api.bootstrap, projects: api.projects, tasks: api.tasks, search: api.search, context: api.context };
  const searchOffsets: number[] = []; const contextOffsets: number[] = [];
  const abort = new AbortController();
  const user = message('u', 'user', '跨页需求');
  const instructions = Array.from({ length: 201 }, (_, index) => ({ id: `hit${index}`, type: 'source' as const, title: '', text: '', projectId: 'p1', timestamp: '', source: user }));
  api.bootstrap = async () => ({ csrfToken: '', allowedRoots: [], dataDirectory: '', version: '', capabilities: { historyMode: 'jsonl', mcp: false } });
  api.projects = async signal => { assert.equal(signal, abort.signal); return [project]; };
  api.tasks = async () => [];
  api.search = async (options, signal) => {
    assert.equal(signal, abort.signal);
    searchOffsets.push(options.offset ?? 0);
    return { total: instructions.length, items: instructions.slice(options.offset, (options.offset ?? 0) + 200) };
  };
  api.context = async (sessionId, limit, offset, signal) => {
    assert.equal(sessionId, 'session1'); assert.equal(limit, 200); assert.equal(signal, abort.signal);
    contextOffsets.push(offset);
    return offset === 0 ? [user, ...Array.from({ length: 199 }, (_, index) => message(`tool${index}`, 'tool', '', { sequence: index + 2, kind: 'tool' }))]
      : [message('last', 'assistant', '第二页最终结果', { sequence: 201 })];
  };
  try {
    const data = await loadViewerData(abort.signal);
    assert.deepEqual(searchOffsets, [0, 200]); assert.deepEqual(contextOffsets, [0, 200]);
    assert.equal(data[0].tasks[0].outputs[0].text, '第二页最终结果');
  } finally { Object.assign(api, original); }
});

test('已取消加载不发起请求；分页失败不会静默返回部分内容', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadViewerData(controller.signal), { name: 'AbortError' });
  const original = { bootstrap: api.bootstrap, projects: api.projects, tasks: api.tasks, search: api.search };
  api.bootstrap = async () => ({ csrfToken: '', allowedRoots: [], dataDirectory: '', version: '', capabilities: { historyMode: 'jsonl', mcp: false } });
  api.projects = async () => [project]; api.tasks = async () => [];
  api.search = async () => { throw new Error('数据读取失败'); };
  try { await assert.rejects(loadViewerData(), /数据读取失败/); }
  finally { Object.assign(api, original); }
});
