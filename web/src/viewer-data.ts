import type { Project, SourceRecord, TaskDetail } from '../../shared/contracts.ts';
import { api } from './api.ts';

export interface ViewerOutput { id: string; text: string; kind: 'text' | 'artifact'; name?: string; timestamp?: string }
export interface ViewerTask {
  id: string; projectId: string; title: string; summary: string; requirements: string[];
  outputs: ViewerOutput[]; updatedAt: string; source: 'task' | 'history'; contentLabel?: string;
}
export interface ViewerProject extends Project { tasks: ViewerTask[]; description: string }

const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const plainText = (value: string) => value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
const excerpt = (value: string, length: number) => { const plain = plainText(value); return plain.length > length ? `${plain.slice(0, length)}…` : plain; };

function userRecord(record: SourceRecord): boolean {
  return record.role === 'user' && record.kind === 'message' && record.sourceKind !== 'subagent'
    && !record.inherited && !['agent', 'system'].includes(record.attribution) && record.sessionId !== 'workbench-human-input' && Boolean(record.text.trim());
}

function finalRecord(record: SourceRecord): boolean {
  if (record.role !== 'assistant' || record.kind !== 'message' || record.sourceKind === 'subagent' || record.inherited || !record.text.trim()) return false;
  try {
    const raw = JSON.parse(record.raw);
    const payload = raw?.payload;
    const phase = payload?.phase ?? payload?.channel ?? payload?.item?.phase ?? payload?.item?.channel;
    return phase === 'final' || phase === 'final_answer';
  } catch { return false; }
}

function historyTitle(text: string): string {
  const paragraphs = text.trim().split(/\n\s*\n/).filter(Boolean);
  // 长素材后跟一个简短请求时，以该请求作为卡片标题，详情仍保留完整原文。
  const last = paragraphs.at(-1) ?? text;
  return excerpt(paragraphs.length > 1 && last.length <= 160 ? last : paragraphs[0] ?? text, 54) || '未命名任务';
}

function userEnvelope(record: SourceRecord): { kind: 'event' | 'response'; messageId?: string } | undefined {
  try {
    const raw = JSON.parse(record.raw); const payload = raw?.payload;
    const kind = raw?.type === 'event_msg' && payload?.type === 'user_message' ? 'event'
      : raw?.type === 'response_item' && payload?.type === 'message' && payload?.role === 'user' ? 'response' : undefined;
    if (!kind) return undefined;
    const id = payload.message_id ?? raw?.metadata?.retained_source?.id?.message_id ?? (kind === 'response' ? payload.id : undefined);
    return { kind, messageId: typeof id === 'string' && id ? id : undefined };
  } catch { return undefined; }
}

function sameUnnumberedMessage(previous: SourceRecord | undefined, current: SourceRecord): boolean {
  if (!previous || previous.turnId || current.turnId || !userRecord(previous) || current.sequence !== previous.sequence + 1 || previous.text !== current.text) return false;
  const first = userEnvelope(previous); const second = userEnvelope(current);
  if (!first || !second || first.kind === second.kind) return false;
  // 缺少消息身份时仅合并完全同时且相邻的双封装；无法确认的重复发送仍保留。
  if (first.messageId || second.messageId) return Boolean(first.messageId && first.messageId === second.messageId);
  return Boolean(previous.timestamp && previous.timestamp === current.timestamp);
}

function historyTasks(records: SourceRecord[], linkedSources: Set<string>): ViewerTask[] {
  const sessions = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (!userRecord(record) && !finalRecord(record)) continue;
    const key = JSON.stringify([record.projectId, record.sessionId]);
    const group = sessions.get(key) ?? [];
    group.push(record); sessions.set(key, group);
  }
  const result: ViewerTask[] = [];
  for (const recordsInSession of sessions.values()) {
    const turns = new Map<string, { users: SourceRecord[]; outputs: SourceRecord[] }>();
    const pairedTurns = new Set<string>();
    let previousMessage: SourceRecord | undefined;
    let latestTurn = '';
    for (const record of recordsInSession.sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp))) {
      const isUser = userRecord(record);
      const duplicateEnvelope = isUser && !pairedTurns.has(latestTurn) && sameUnnumberedMessage(previousMessage, record);
      const turnKey = record.turnId || (isUser && !duplicateEnvelope ? `message:${record.id}` : latestTurn);
      previousMessage = record;
      if (!turnKey) continue;
      if (duplicateEnvelope) pairedTurns.add(turnKey);
      const turn = turns.get(turnKey) ?? { users: [], outputs: [] };
      if (isUser) { turn.users.push(record); latestTurn = turnKey; } else turn.outputs.push(record);
      turns.set(turnKey, turn);
    }
    for (const turn of turns.values()) {
      const users = turn.users.filter(record => !linkedSources.has(`${record.projectId}:${record.id}`));
      if (!users.length) continue;
      const first = users[0];
      const requirements = unique(users.map(record => record.text));
      const outputs: ViewerOutput[] = [];
      const seenOutputs = new Set<string>();
      for (const output of turn.outputs) {
        const text = output.text.trim();
        if (seenOutputs.has(text)) continue;
        seenOutputs.add(text);
        outputs.push({ id: output.id, text, kind: 'text', timestamp: output.timestamp });
      }
      const updatedAt = [...users, ...turn.outputs].map(record => record.timestamp).sort().at(-1) ?? first.timestamp;
      result.push({ id: `history:${first.id}`, projectId: first.projectId, title: historyTitle(first.text), summary: excerpt(first.text, 140),
        requirements, outputs, updatedAt, source: 'history', contentLabel: '历史对话' });
    }
  }
  return result;
}

function savedTask(detail: TaskDetail): ViewerTask {
  const revision = detail.revisions.find(item => item.id === detail.task.currentRevisionId);
  const content = revision?.content ?? (!detail.task.currentRevisionId ? detail.draft?.content : undefined);
  const requirements = content ? unique([
    content.goal, ...content.requirements, content.scope,
    ...(content.nonGoals.trim() ? [`不包含：${content.nonGoals}`] : []),
    ...content.criteria.filter(item => item.text.trim()).map(item => `验收要求${item.required ? '' : '（可选）'}：${item.text}`),
    ...content.conflicts.filter(text => text.trim()).map(text => `待明确：${text}`),
  ]) : [];
  const receipt = revision ? detail.receipts.filter(item => item.revisionId === revision.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const outputs: ViewerOutput[] = [];
  if (receipt) {
    const status = receipt.status === 'failed' ? '执行失败：' : receipt.status === 'interrupted' ? '执行中断：' : '';
    if (receipt.summary.trim()) outputs.push({ id: receipt.receiptId, kind: 'text', text: `${status}${receipt.summary}`, timestamp: receipt.createdAt });
    for (const evidence of receipt.evidence) {
      if (evidence.kind !== 'artifact' || !evidence.text.trim()) continue;
      outputs.push({ id: `${receipt.receiptId}:${evidence.id}`, kind: 'artifact', name: '产物记录', text: evidence.text, timestamp: receipt.createdAt });
    }
  }
  return { id: detail.task.id, projectId: detail.task.projectId, title: detail.task.title, summary: excerpt(requirements[0] ?? '', 140),
    requirements, outputs, updatedAt: detail.task.updatedAt, source: 'task', contentLabel: revision ? '任务内容' : '草稿内容' };
}

export function buildViewerProjects(projects: Project[], details: TaskDetail[], records: SourceRecord[]): ViewerProject[] {
  const projectIds = new Set(projects.map(project => project.id));
  const relevantDetails = details.filter(detail => projectIds.has(detail.task.projectId));
  const linkedSources = new Set<string>();
  for (const detail of relevantDetails) {
    const contents = [...detail.revisions.map(revision => revision.content), ...(detail.draft ? [detail.draft.content] : [])];
    for (const content of contents) for (const id of content.sourceIds) linkedSources.add(`${detail.task.projectId}:${id}`);
  }
  const tasks = [...relevantDetails.map(savedTask), ...historyTasks(records.filter(record => projectIds.has(record.projectId)), linkedSources)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return projects.map(project => ({ ...project, tasks: tasks.filter(task => task.projectId === project.id), description: '查看本项目的需求与输出' }));
}

function nearSubsequence(needle: string, text: string): boolean {
  if (needle.length < 2 || needle.length > 32) return false;
  for (const character of new Set(needle)) if (!text.includes(character)) return false;
  const maxSpan = Math.max(needle.length + 2, needle.length * 2);
  let start = text.indexOf(needle[0]);
  while (start !== -1) {
    let cursor = start + 1;
    let matched = true;
    const end = Math.min(start + maxSpan, text.length);
    for (let i = 1; i < needle.length; i++) {
      // 仅扫描候选起点的短窗口，不能先扫描整个剩余长段落再判断距离。
      while (cursor < end && text[cursor] !== needle[i]) cursor++;
      if (cursor >= end) { matched = false; break; }
      cursor++;
    }
    if (matched) return true;
    start = text.indexOf(needle[0], start + 1);
  }
  return false;
}

export function matchesFuzzy(query: string, ...texts: string[]): boolean {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  // 不跨段、跨句跳字；短词必须在邻近字符内命中，避免长输出的偶然匹配。
  const segments = texts.flatMap(text => normalize(text).split(/[\r\n。！？!?；;]/)).filter(Boolean);
  return tokens.every(token => segments.some(segment => segment.includes(token) || nearSubsequence(token, segment)));
}

export function filterViewerTasks(tasks: ViewerTask[], query: string): ViewerTask[] {
  const needle = normalize(query);
  if (!needle) return tasks;
  const score = (task: ViewerTask) => normalize(task.title) === needle ? 3 : normalize(task.title).includes(needle) ? 2 : 1;
  return tasks.filter(task => matchesFuzzy(query, task.title, task.summary, ...task.requirements, ...task.outputs.map(output => output.text)))
    .sort((a, b) => score(b) - score(a));
}

async function loadInstructions(signal?: AbortSignal): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    signal?.throwIfAborted();
    const page = await api.search({ scope: 'instructions', archived: true, limit: 200, offset }, signal);
    records.push(...page.items.flatMap(item => item.source ? [item.source] : []));
    if (offset + page.items.length >= page.total) break;
    if (!page.items.length) throw new Error('历史记录分页未能完整读取，请重新加载。');
  }
  return records;
}

async function loadSession(sessionId: string, signal?: AbortSignal): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    signal?.throwIfAborted();
    const page = await api.context(sessionId, 200, offset, signal);
    records.push(...page);
    if (page.length < 200) break;
  }
  return records;
}

export async function loadViewerData(signal?: AbortSignal): Promise<ViewerProject[]> {
  signal?.throwIfAborted();
  await api.bootstrap();
  signal?.throwIfAborted();
  const [projects, tasks, instructions] = await Promise.all([api.projects(signal), api.tasks({ archived: true }, signal), loadInstructions(signal)]);
  const sessions = [...new Set(instructions.filter(userRecord).map(record => record.sessionId))];
  const details: TaskDetail[] = [];
  const records: SourceRecord[] = [];
  // 限制并行读取，避免历史较多时同时发出大量请求。
  const detailWork = async () => { for (let i = 0; i < tasks.length; i += 4) details.push(...await Promise.all(tasks.slice(i, i + 4).map(task => api.task(task.id, signal)))); };
  const historyWork = async () => { for (let i = 0; i < sessions.length; i += 4) records.push(...(await Promise.all(sessions.slice(i, i + 4).map(id => loadSession(id, signal)))).flat()); };
  await Promise.all([detailWork(), historyWork()]);
  signal?.throwIfAborted();
  return buildViewerProjects(projects, details, records);
}
