import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress } from 'node:zlib';

export interface NativeOutput { id: string; text: string }
export interface NativeTurn { id: string; requirements: string[]; outputs: NativeOutput[]; createdAt?: string; status?: string }
export interface NativeHistoryThread { id: string; turns: NativeTurn[]; metadata?: { title?: string; cwd?: string; parentId?: string; source?: string; archived?: boolean } }
export interface NativeHistoryCandidate { id: string; rolloutPath?: string; archived?: boolean }
export interface NativeHistoryResult { threads: NativeHistoryThread[]; warnings: string[]; unavailableIds: string[]; stats: { projectedThreads: number; projectedTurns: number; fallbackThreads: number; filesScanned: number; unreadableFiles: number; generationAliases: number; fallbackFiles: number; emptyThreads: number } }
type Json = Record<string, any>;
interface Rollout { path: string; id: string; storageId: string; bytes: number; metadata: NonNullable<NativeHistoryThread['metadata']> }
interface TurnState { value: NativeTurn; ordinal: number; seen: Set<string> }
interface ThreadState { value: NativeHistoryThread; turns: Map<string, TurnState> }
const headerCache = new Map<string, { size: number; mtime: number; header: Json }>();
const asObject = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const asString = (value: unknown) => typeof value === 'string' ? value : '';
const iso = (value: unknown): string | undefined => { const time = typeof value === 'number' ? value < 1e12 ? value * 1000 : value : Date.parse(asString(value)); return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined; };
const finalPhase = (value: unknown) => value === 'final' || value === 'final_answer';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const fileName = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || '图片';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const item = asObject(part);
    if (['text', 'input_text', 'output_text'].includes(item.type)) return asString(item.text);
    if (['localImage', 'local_image', 'input_image', 'image', 'image_url'].includes(item.type)) return item.path ? `【图片附件：${fileName(asString(item.path))}】` : '【图片附件】';
    return '';
  }).filter(Boolean).join('\n');
}

async function lines(path: string, visit: (line: string, ordinal: number) => boolean | void, start = 0): Promise<void> {
  const source = createReadStream(path, { start, highWaterMark: 64 * 1024 });
  const input = path.endsWith('.zst') ? source.pipe(createZstdDecompress()) : source;
  if (input !== source) source.on('error', error => input.destroy(error));
  const decoder = new StringDecoder('utf8');
  let pending = ''; let ordinal = 0;
  try {
    for await (const chunk of input) {
      pending += decoder.write(chunk as Buffer);
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '').replace(/^\uFEFF/, '');
        pending = pending.slice(end + 1);
        if (visit(line, ordinal++) === false) return;
      }
    }
    pending += decoder.end();
    if (pending.trim()) visit(pending.replace(/^\uFEFF/, ''), ordinal);
  } finally { input.destroy(); source.destroy(); }
}

async function discover(codexHome: string, warnings: string[]): Promise<Rollout[]> {
  const paths: string[] = [];
  async function walk(path: string, boundary: string) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`无法枚举历史目录 ${path}：${errorText(error)}`); return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file, boundary);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name)) {
        const actual = await realpath(file); const rel = relative(boundary, actual);
        if (!rel.startsWith('..') && !isAbsolute(rel)) paths.push(actual);
      }
    }
  }
  for (const name of ['sessions', 'archived_sessions']) {
    const root = join(codexHome, name);
    const actual = await realpath(root).catch(() => root);
    await walk(root, actual);
  }
  const rollouts: Rollout[] = [];
  for (let index = 0; index < paths.length; index += 8) {
    await Promise.all(paths.slice(index, index + 8).map(async path => {
      try {
        const info = await stat(path); const cached = headerCache.get(path);
        let header: Json | undefined = cached?.size === info.size && cached.mtime === info.mtimeMs ? cached.header : undefined;
        if (!header) {
          await lines(path, (line, ordinal) => {
            if (line.trim()) {
              const record = JSON.parse(line);
              if (record.type === 'session_meta') { header = asObject(record.payload); return false; }
            }
            if (ordinal >= 15) return false;
          });
          if (header) headerCache.set(path, { size: info.size, mtime: info.mtimeMs, header });
        }
        if (!header || typeof header.id !== 'string') { warnings.push(`历史文件缺少会话元数据：${path}`); return; }
        const ids = basename(path).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/ig);
        const parent = asString(header.parent_thread_id) || asString(asObject(asObject(asObject(header.source).subagent).thread_spawn).parent_thread_id);
        rollouts.push({ path, id: header.id, storageId: ids?.at(-1) ?? header.id, bytes: info.size,
          metadata: { cwd: asString(header.cwd), title: asString(header.title) || undefined, parentId: asString(parent) || undefined,
            source: typeof header.source === 'string' ? header.source : asObject(header.source).subagent ? 'subagent' : 'unknown', archived: path.toLowerCase().includes('archived_sessions') } });
      } catch (error) { warnings.push(`无法读取历史文件 ${path}：${errorText(error)}`); }
    }));
  }
  const existingPaths = new Set(paths);
  for (const path of headerCache.keys()) if (!existingPaths.has(path)) headerCache.delete(path);
  return rollouts.sort((a, b) => a.path.localeCompare(b.path));
}

async function candidatesFromState(codexHome: string): Promise<NativeHistoryCandidate[]> {
  const path = join(codexHome, 'state_5.sqlite');
  if (!await stat(path).catch(() => undefined)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT id,rollout_path AS rolloutPath,archived FROM threads').all() as unknown as NativeHistoryCandidate[]; }
  finally { db.close(); }
}

export async function readNativeHistory(codexHome: string, candidates?: NativeHistoryCandidate[]): Promise<NativeHistoryResult> {
  const result: NativeHistoryResult = { threads: [], warnings: [], unavailableIds: [], stats: { projectedThreads: 0, projectedTurns: 0, fallbackThreads: 0, filesScanned: 0, unreadableFiles: 0, generationAliases: 0, fallbackFiles: 0, emptyThreads: 0 } };
  const selected = candidates ?? await candidatesFromState(codexHome);
  const rollouts = await discover(resolve(codexHome), result.warnings);
  result.stats.filesScanned = rollouts.length;
  result.stats.unreadableFiles = result.warnings.length;
  const aliases = new Map(rollouts.map(file => [file.storageId, file.id]));
  result.stats.generationAliases = rollouts.filter(file => file.storageId !== file.id).length;
  const threads = new Map<string, ThreadState>();
  const ensureThread = (id: string) => {
    let thread = threads.get(id);
    if (!thread) { thread = { value: { id, turns: [] }, turns: new Map() }; threads.set(id, thread); }
    return thread;
  };
  const ensureTurn = (threadId: string, turnId: string, ordinal: number, createdAt?: string) => {
    const thread = ensureThread(threadId);
    let turn = thread.turns.get(turnId);
    if (!turn) { turn = { value: { id: turnId, requirements: [], outputs: [], ...(createdAt ? { createdAt } : {}) }, ordinal, seen: new Set() }; thread.turns.set(turnId, turn); }
    return turn;
  };
  for (const candidate of selected) ensureThread(candidate.id).value.metadata = { archived: Boolean(candidate.archived) };
  for (const file of rollouts) {
    const thread = ensureThread(file.id);
    thread.value.metadata = { ...thread.value.metadata, ...file.metadata, archived: selected.find(item => item.id === file.id)?.archived ?? file.metadata.archived };
  }
  const projection = new Map<string, { offset: number; ordinal: number }>();
  const projectedThreads = new Set<string>();
  const readableThreads = new Set<string>();
  const failedThreads = new Set<string>();
  const dbPath = join(codexHome, 'thread_history_1.sqlite');
  if (await stat(dbPath).catch(() => undefined)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 一个只读事务读取一致快照，运行中的 Codex 可继续写 WAL。
      db.exec('BEGIN');
      for (const raw of db.prepare('SELECT * FROM thread_history_projection_state').iterate()) projection.set(String(raw.thread_id), { offset: Number(raw.next_rollout_byte_offset), ordinal: Number(raw.next_rollout_ordinal) });
      for (const row of db.prepare('SELECT * FROM thread_turns ORDER BY thread_id,rollout_ordinal').iterate()) {
        const threadId = aliases.get(String(row.thread_id)) ?? String(row.thread_id);
        const turn = ensureTurn(threadId, String(row.turn_id), Number(row.rollout_ordinal), iso(row.started_at));
        turn.value.status = String(row.status);
      }
      for (const row of db.prepare("SELECT thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type FROM thread_items WHERE item_type IN ('userMessage','agentMessage') ORDER BY thread_id,rollout_ordinal").iterate()) {
        const threadId = aliases.get(String(row.thread_id)) ?? String(row.thread_id);
        projectedThreads.add(threadId);
        let item: Json;
        try { item = asObject(JSON.parse(String(row.item_json))); }
        catch {
          // 部分消息可读不代表正文完整；损坏的最终输出不能冒充暂无输出。
          failedThreads.add(threadId);
          result.warnings.push(`无法解析线程 ${threadId} 的消息 ${String(row.item_id)}`); continue;
        }
        if (row.item_type === 'agentMessage' && !finalPhase(item.phase)) continue;
        const turn = ensureTurn(threadId, String(row.turn_id), Number(row.rollout_ordinal), iso(row.created_at_ms));
        const key = `${String(row.item_type)}:${String(row.item_id)}`;
        if (turn.seen.has(key)) continue;
        turn.seen.add(key);
        if (row.item_type === 'userMessage') { const text = contentText(item.content); if (text.trim()) turn.value.requirements.push(text); }
        else if (typeof item.text === 'string' && item.text.trim()) turn.value.outputs.push({ id: String(row.item_id), text: item.text });
      }
      db.exec('COMMIT');
      for (const id of projectedThreads) readableThreads.add(id);
      for (const id of projection.keys()) readableThreads.add(aliases.get(id) ?? id);
    } catch (error) { result.warnings.push(`原生正文投影读取失败，将尝试原始日志：${errorText(error)}`); projection.clear(); }
    finally { db.close(); }
  }
  result.stats.projectedThreads = projectedThreads.size;
  result.stats.projectedTurns = [...threads.values()].reduce((sum, thread) => sum + thread.turns.size, 0);
  const fallbackThreads = new Set<string>();

  for (const file of rollouts) {
    const progress = projection.get(file.storageId);
    if (progress && (file.path.endsWith('.zst') || file.bytes === progress.offset)) continue;
    const start = progress && !file.path.endsWith('.zst') && file.bytes > progress.offset ? progress.offset : 0;
    if (progress && start === 0) result.warnings.push(`线程 ${file.id} 的日志长度与投影不一致，按消息身份合并读取。`);
    const thread = ensureThread(file.id);
    let currentTurn = start ? [...thread.turns.values()].sort((a, b) => a.ordinal - b.ordinal).at(-1)?.value.id ?? '' : '';
    let inherited = false;
    let malformed = 0;
    let firstMeta = start === 0;
    let turnFinished = currentTurn ? thread.turns.get(currentTurn)?.value.status === 'completed' : false;
    let explicitCurrentTurn = Boolean(currentTurn && !turnFinished);
    const addedTexts = new Map<string, Set<string>>();
    const getTurn = (id: string, ordinal: number, timestamp: unknown) => ensureTurn(file.id, id, ordinal + (progress?.ordinal ?? 0), iso(timestamp));
    const add = (role: 'user' | 'assistant', text: string, id: string, ordinal: number, timestamp: unknown) => {
      if (!text.trim() || inherited) return;
      if (role === 'user' && !explicitCurrentTurn && (turnFinished || Boolean(currentTurn && thread.turns.get(currentTurn)?.value.outputs.length))) {
        currentTurn = ''; turnFinished = false;
      }
      if (!currentTurn) currentTurn = `rollout:${file.storageId}:${ordinal}`;
      const turn = getTurn(currentTurn, ordinal, timestamp);
      const key = `${role === 'user' ? 'userMessage' : 'agentMessage'}:${id}`;
      const texts = addedTexts.get(currentTurn) ?? new Set([...turn.value.requirements.map(value => `user:${value}`), ...turn.value.outputs.map(value => `assistant:${value.text}`)]);
      addedTexts.set(currentTurn, texts);
      if (turn.seen.has(key) || texts.has(`${role}:${text}`)) return;
      turn.seen.add(key); texts.add(`${role}:${text}`);
      if (role === 'user') turn.value.requirements.push(text); else turn.value.outputs.push({ id, text });
      fallbackThreads.add(file.id);
    };
    try {
      result.stats.fallbackFiles++;
      await lines(file.path, (line, ordinal) => {
        if (!line.trim()) return;
        let record: Json;
        try { record = asObject(JSON.parse(line)); } catch { malformed++; return; }
        const payload = asObject(record.payload); const event = asString(payload.type);
        if (record.type === 'session_meta') {
          if (firstMeta) firstMeta = false; else inherited = payload.id !== file.id;
          return;
        }
        if (record.type === 'inter_agent_communication_metadata' && (payload.type === 'trigger_turn' || payload.kind === 'trigger_turn')) inherited = false;
        if (payload.thread_id === file.id) inherited = false;
        if (inherited) return;
        if (record.type === 'turn_context' || event === 'task_started') {
          currentTurn = asString(payload.turn_id) || asString(payload.id) || currentTurn;
          explicitCurrentTurn = Boolean(currentTurn); turnFinished = false;
          if (currentTurn) getTurn(currentTurn, ordinal, record.timestamp).value.status = 'inProgress';
          return;
        }
        if (record.type === 'event_msg' && ['thread_rolled_back', 'rollback'].includes(event)) {
          const count = Number(payload.num_turns ?? payload.turns ?? 0);
          if (Number.isInteger(count) && count > 0) {
            const ids = [...thread.turns.values()].sort((a, b) => a.ordinal - b.ordinal).slice(-count).map(turn => turn.value.id);
            for (const id of ids) thread.turns.delete(id);
            currentTurn = [...thread.turns.values()].sort((a, b) => a.ordinal - b.ordinal).at(-1)?.value.id ?? '';
          }
          return;
        }
        const explicitTurn = asString(payload.turn_id);
        if (explicitTurn) { currentTurn = explicitTurn; explicitCurrentTurn = true; }
        if (record.type === 'event_msg' && event === 'user_message') {
          const extra = [...(Array.isArray(payload.images) ? payload.images.map(() => '【图片附件】') : []), ...(Array.isArray(payload.local_images) ? payload.local_images.map((path: unknown) => `【图片附件：${fileName(asString(path))}】`) : [])];
          add('user', [asString(payload.message) || contentText(payload.content), ...extra].filter(Boolean).join('\n'), asString(payload.id) || `fallback-user:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
        } else if (record.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
          if (payload.role === 'user' || finalPhase(payload.phase ?? payload.channel)) add(payload.role, contentText(payload.content), asString(payload.id) || `fallback-message:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
        } else if (record.type === 'event_msg' && event === 'agent_message' && finalPhase(payload.phase ?? payload.channel)) {
          add('assistant', asString(payload.message) || contentText(payload.content), asString(payload.id) || `fallback-final:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
        } else if (record.type === 'event_msg' && event === 'item_completed') {
          const item = asObject(payload.item);
          if (['AgentMessage', 'agentMessage'].includes(item.type) && finalPhase(item.phase ?? item.channel)) add('assistant', asString(item.text) || contentText(item.content), asString(item.id) || `fallback-final:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
          else if (['UserMessage', 'userMessage'].includes(item.type)) add('user', contentText(item.content), asString(item.id) || `fallback-user:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
        } else if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(event) && currentTurn) {
          if (event === 'task_complete' && typeof payload.last_agent_message === 'string') add('assistant', payload.last_agent_message, `fallback-complete:${file.storageId}:${ordinal}`, ordinal, record.timestamp);
          getTurn(currentTurn, ordinal, record.timestamp).value.status = event === 'task_complete' ? 'completed' : 'interrupted';
          turnFinished = true; explicitCurrentTurn = false;
        }
      }, start);
      readableThreads.add(file.id);
      if (malformed) { failedThreads.add(file.id); result.warnings.push(`历史文件 ${file.path} 含 ${malformed} 条未能解析的行（包含尚未写完的尾行）。`); }
    } catch (error) { failedThreads.add(file.id); result.stats.unreadableFiles++; result.warnings.push(`历史正文读取失败 ${file.path}：${errorText(error)}`); }
  }
  result.stats.fallbackThreads = fallbackThreads.size;
  result.threads = [...threads.values()].map(thread => {
    thread.value.turns = [...thread.turns.values()].filter(turn => turn.value.requirements.length || turn.value.outputs.length)
      .sort((a, b) => (a.value.createdAt ?? '').localeCompare(b.value.createdAt ?? '') || a.ordinal - b.ordinal).map(turn => turn.value);
    return thread.value;
  });
  result.stats.emptyThreads = result.threads.filter(thread => !thread.turns.length).length;
  result.unavailableIds = [...threads.keys()].filter(id => !readableThreads.has(id) || failedThreads.has(id));
  for (const id of result.unavailableIds) if (!failedThreads.has(id)) result.warnings.push(`线程 ${id} 没有可读取的正文投影或原始历史文件。`);
  return result;
}
