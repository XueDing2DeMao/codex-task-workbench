import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeCatalog, NativeCoverage, NativeExchangeExportRequest, NativeExportRequest, NativeExportResult, NativeProject, NativeSearchResult, NativeTaskDetail, NativeTaskSummary } from '../../shared/native-contracts.ts';
import { readNativeCatalog } from './catalog.ts';
import type { NativeThreadMeta } from './catalog.ts';
import { readNativeHistory } from './history.ts';
import { ApiError, assertAllowedKeys } from '../security.ts';
import { formatNativeExchangeMarkdown, formatNativeMarkdown } from './markdown.ts';
import type { MarkdownTaskGroup } from './markdown.ts';

interface SourceCatalog { projects: { id: string; name: string; rootPath: string; description?: string }[]; threads: NativeThreadMeta[]; warnings: string[] }
interface SourceHistory { threads: { id: string; turns: NativeTaskDetail['exchanges']; metadata?: { parentId?: string } }[]; warnings: string[]; unavailableIds?: string[] }
export interface NativeSnapshot { catalog: NativeCatalog; details: Map<string, NativeTaskDetail>; searchable: Map<string, string[]> }
const plain = (text: string) => text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

export function buildNativeSnapshot(metadata: SourceCatalog, history: SourceHistory, readAt = new Date().toISOString()): NativeSnapshot {
  const records = new Map(history.threads.map(thread => [thread.id, thread]));
  const unavailable = new Set(history.unavailableIds ?? []);
  const details = new Map<string, NativeTaskDetail>();
  const searchable = new Map<string, string[]>();
  const coverage: NativeCoverage = { catalogTasks: metadata.threads.length, loadedTasks: 0, emptyTasks: 0, unavailableTasks: 0, turns: 0, requirements: 0, outputs: 0, archivedTasks: 0, subagentTasks: 0, readAt, source: '本机 Codex', warnings: [...new Set([...metadata.warnings, ...history.warnings])] };
  for (const thread of metadata.threads) {
    const source = records.get(thread.id);
    const exchanges = source?.turns ?? [];
    const requirements = exchanges.flatMap(turn => turn.requirements);
    const outputs = exchanges.flatMap(turn => turn.outputs);
    const availability = !source || unavailable.has(thread.id) ? 'unavailable' : requirements.length || outputs.length ? 'available' : 'empty';
    coverage.loadedTasks += availability !== 'unavailable' ? 1 : 0;
    coverage.emptyTasks += availability === 'empty' ? 1 : 0;
    coverage.unavailableTasks += availability === 'unavailable' ? 1 : 0;
    coverage.archivedTasks += thread.archived ? 1 : 0;
    coverage.subagentTasks += thread.source === 'subagent' || thread.source === 'guardian' ? 1 : 0;
    coverage.turns += exchanges.length; coverage.requirements += requirements.length; coverage.outputs += outputs.length;
    const task: NativeTaskDetail = {
      id: thread.id, projectId: thread.projectId, title: thread.title || plain(requirements[0] ?? '').slice(0, 80) || '未命名任务',
      summary: plain(requirements[0] ?? outputs[0]?.text ?? '').slice(0, 180), createdAt: thread.createdAt,
      updatedAt: thread.updatedAt, archived: thread.archived, source: thread.source, parentId: thread.parentId ?? source?.metadata?.parentId,
      turnCount: exchanges.length, outputCount: outputs.length, availability, exchanges,
    };
    details.set(task.id, task);
  }
  // 日志可能补回审查任务的父关系；全部记录就绪后再确定项目并建立索引。
  for (const task of details.values()) {
    if (task.source !== 'user') {
      let ancestor: NativeTaskDetail | undefined = task;
      const visited = new Set<string>();
      while (ancestor && ancestor.source !== 'user' && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        ancestor = ancestor.parentId ? details.get(ancestor.parentId) : undefined;
      }
      if (ancestor?.source === 'user') task.projectId = ancestor.projectId;
    }
    const project = metadata.projects.find(project => project.id === task.projectId);
    const requirements = task.exchanges.flatMap(turn => turn.requirements);
    const outputs = task.exchanges.flatMap(turn => turn.outputs);
    searchable.set(task.id, [task.title, project?.name ?? '', ...requirements, ...outputs.map(output => output.text)]
      .flatMap(text => normalize(text).split(/[\r\n。！？!?；;]/)).filter(Boolean));
  }
  const tasks: NativeTaskSummary[] = [...details.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(({ exchanges: _, ...summary }) => summary);
  const counts = new Map<string, number>();
  for (const task of tasks) if (task.source === 'user') counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  const projects: NativeProject[] = metadata.projects.map(project => ({ ...project, description: project.description || project.rootPath || '尚未归属到项目的任务', taskCount: counts.get(project.id) ?? 0 }));
  if (coverage.unavailableTasks) coverage.warnings.unshift(`${coverage.unavailableTasks} 个任务保留了目录信息，但未能读取正文。`);
  return { catalog: { projects, tasks, coverage }, details, searchable };
}

function fuzzy(needle: string, text: string) {
  if (text.includes(needle)) return true;
  if (needle.length < 2 || needle.length > 32) return false;
  for (const character of new Set(needle)) if (!text.includes(character)) return false;
  const span = Math.max(needle.length * 2, needle.length + 2);
  for (let start = text.indexOf(needle[0]); start >= 0; start = text.indexOf(needle[0], start + 1)) {
    const end = Math.min(start + span, text.length);
    let cursor = start + 1; let found = true;
    for (let index = 1; index < needle.length; index++) {
      while (cursor < end && text[cursor] !== needle[index]) cursor++;
      if (cursor === end) { found = false; break; }
      cursor++;
    }
    if (found) return true;
  }
  return false;
}
function matches(tokens: string[], segments: string[]) { return tokens.every(token => segments.some(segment => fuzzy(token, segment))); }
function excerpt(task: NativeTaskDetail, tokens: string[]): { matchExcerpt: string; matchTurnId?: string } {
  let best = { score: 0, text: task.summary, offset: 0, turnId: undefined as string | undefined };
  for (const turn of task.exchanges) for (const text of [...turn.requirements, ...turn.outputs.map(output => output.text)]) {
    const lower = normalize(text); const segments = lower.split(/[\r\n。！？!?；;]/);
    const score = tokens.filter(token => segments.some(segment => fuzzy(token, segment))).length;
    if (score <= best.score) continue;
    const offset = tokens.reduce((value, token) => { const index = lower.indexOf(token); return index < 0 ? value : Math.min(value, index); }, Infinity);
    best = { score, text, offset: Number.isFinite(offset) ? offset : 0, turnId: turn.id };
  }
  return { matchExcerpt: `${best.offset > 45 ? '…' : ''}${plain(best.text.slice(Math.max(0, best.offset - 45), best.offset + 150))}${best.offset + 150 < best.text.length ? '…' : ''}`, matchTurnId: best.turnId };
}

export function searchNativeSnapshot(snapshot: NativeSnapshot, query: string): NativeSearchResult {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  const projects = snapshot.catalog.projects.filter(project => matches(tokens, [normalize(project.name), normalize(project.description)]));
  const tasks = snapshot.catalog.tasks.filter(task => matches(tokens, snapshot.searchable.get(task.id) ?? []))
    .map(task => ({ ...task, ...(tokens.length ? excerpt(snapshot.details.get(task.id)!, tokens) : { matchExcerpt: task.summary }) }));
  const score = (task: NativeTaskSummary) => tokens.every(token => normalize(task.title).includes(token)) ? 2 : 1;
  tasks.sort((a, b) => score(b) - score(a));
  return { query, projects, tasks, total: projects.length + tasks.length, readAt: snapshot.catalog.coverage.readAt };
}

export function exportNativeSnapshot(snapshot: NativeSnapshot, input: NativeExportRequest, exportedAt = new Date()): NativeExportResult {
  assertAllowedKeys(input, ['projectId', 'scope', 'taskIds', 'includeRelated']);
  if (typeof input.projectId !== 'string' || !input.projectId.trim()) throw new ApiError(400, '请选择有效项目');
  if (input.scope !== 'project' && input.scope !== 'tasks') throw new ApiError(400, '导出范围无效');
  if (typeof input.includeRelated !== 'boolean') throw new ApiError(400, '包含子任务与审查的选项无效');
  if (input.scope === 'project' && Object.hasOwn(input, 'taskIds')) throw new ApiError(400, '导出整个项目时不能指定任务');
  if (input.scope === 'tasks' && (!Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.some(id => typeof id !== 'string' || !id.trim()))) {
    throw new ApiError(400, '请至少选择一个有效任务');
  }
  const project = snapshot.catalog.projects.find(item => item.id === input.projectId);
  if (!project) throw new ApiError(404, '没有找到这个 Codex 项目，请刷新后重试');
  const mainTasks = snapshot.catalog.tasks.filter(task => task.projectId === project.id && task.source === 'user');
  const selected = input.scope === 'tasks' ? new Set(input.taskIds!) : new Set(mainTasks.map(task => task.id));
  const allowed = new Set(mainTasks.map(task => task.id));
  for (const id of selected) if (!allowed.has(id)) throw new ApiError(400, '所选任务已不存在或不属于本项目的主任务，请刷新后重新选择');
  const groups: MarkdownTaskGroup[] = [];
  const failures: string[] = [];
  for (const summary of mainTasks) {
    if (!selected.has(summary.id)) continue;
    const task = snapshot.details.get(summary.id);
    if (!task || task.availability === 'unavailable') failures.push(summary.title);
    else groups.push({ task, related: [] });
  }
  if (input.includeRelated) {
    const byRoot = new Map(groups.map(group => [group.task.id, group]));
    const byId = new Map(snapshot.catalog.tasks.map(task => [task.id, task]));
    for (const summary of snapshot.catalog.tasks) {
      if (summary.source === 'user') continue;
      let ancestor: NativeTaskSummary | undefined = summary;
      const visited = new Set<string>();
      while (ancestor && ancestor.source !== 'user' && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
      if (!ancestor || ancestor.source !== 'user') continue;
      const group = byRoot.get(ancestor.id);
      if (!group) continue;
      const child = snapshot.details.get(summary.id);
      if (!child || child.availability === 'unavailable') failures.push(summary.title);
      else group.related.push(child);
    }
  }
  if (failures.length) throw new ApiError(503, `以下任务正文读取失败，未生成导出文件：${failures.join('、')}。请刷新后重试。`, 'NATIVE_EXPORT_INCOMPLETE');
  return formatNativeMarkdown(project, groups, input, snapshot.catalog.coverage.readAt, exportedAt);
}

export function exportNativeExchange(snapshot: NativeSnapshot, input: NativeExchangeExportRequest, exportedAt = new Date()): NativeExportResult {
  assertAllowedKeys(input, ['taskId', 'exchangeId']);
  if (typeof input.taskId !== 'string' || !input.taskId.trim() || typeof input.exchangeId !== 'string' || !input.exchangeId.trim()) {
    throw new ApiError(400, '请提供有效的任务和轮次 ID');
  }
  const task = snapshot.details.get(input.taskId);
  if (!task) throw new ApiError(404, '没有找到这个 Codex 任务，请刷新后重试');
  const project = snapshot.catalog.projects.find(item => item.id === task.projectId);
  if (!project) throw new ApiError(404, '没有找到任务所属项目，请刷新后重试');
  if (task.availability === 'unavailable') throw new ApiError(503, `任务正文读取失败，未生成导出文件：${task.title}。请刷新后重试。`, 'NATIVE_EXPORT_INCOMPLETE');
  const exchangeIndex = task.exchanges.findIndex(exchange => exchange.id === input.exchangeId);
  if (exchangeIndex < 0) throw new ApiError(404, '没有找到该任务中的这一轮记录，请刷新后重试');
  return formatNativeExchangeMarkdown(project, task, exchangeIndex, snapshot.catalog.coverage.readAt, exportedAt);
}

export interface NativeReader {
  catalog(force?: boolean): Promise<NativeCatalog>;
  task(id: string): Promise<NativeTaskDetail>;
  search(query: string): Promise<NativeSearchResult>;
  exportMarkdown(input: NativeExportRequest): Promise<NativeExportResult>;
  exportExchange(input: NativeExchangeExportRequest): Promise<NativeExportResult>;
}
export function createNativeReader(codexHome: string): NativeReader {
  let snapshot: NativeSnapshot | undefined;
  let pending: Promise<NativeSnapshot> | undefined;
  let signature = '';
  let checkedAt = 0;
  async function sourceSignature() {
    const names = ['state_5.sqlite', 'state_5.sqlite-wal', 'thread_history_1.sqlite', 'thread_history_1.sqlite-wal', '.codex-global-state.json', 'session_index.jsonl'];
    return (await Promise.all(names.map(async name => { const info = await stat(join(codexHome, name)).catch(() => undefined); return `${name}:${info?.size}:${info?.mtimeMs}`; }))).join('|');
  }
  async function read(force = false) {
    if (pending) return pending;
    if (!force && snapshot && Date.now() - checkedAt < 5000) return snapshot;
    pending = (async () => {
      const nextSignature = await sourceSignature();
      if (!force && snapshot && nextSignature === signature) { checkedAt = Date.now(); return snapshot; }
      const metadata = await readNativeCatalog(codexHome);
      const history = await readNativeHistory(codexHome, metadata.threads);
      snapshot = buildNativeSnapshot(metadata, history);
      signature = nextSignature; checkedAt = Date.now();
      return snapshot;
    })().catch(error => { throw new ApiError(503, `本机 Codex 数据读取未完成：${error instanceof Error ? error.message : '请重试'}`, 'NATIVE_READ_FAILED'); }).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    catalog: async force => (await read(force)).catalog,
    task: async id => { const task = (await read()).details.get(id); if (!task) throw new ApiError(404, '没有找到这个 Codex 任务'); return task; },
    search: async query => searchNativeSnapshot(await read(), query),
    exportMarkdown: async input => exportNativeSnapshot(await read(), input),
    exportExchange: async input => exportNativeExchange(await read(), input),
  };
}
