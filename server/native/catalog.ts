import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

export type NativeThreadSource = 'user' | 'subagent' | 'guardian' | 'unknown';
export interface NativeThreadMeta {
  id: string; title: string; cwd: string; projectId: string; archived: boolean;
  source: NativeThreadSource; parentId?: string; createdAt: string; updatedAt: string; rolloutPath?: string;
}
export interface NativeProjectMeta { id: string; name: string; rootPath: string; description?: string }
export interface NativeCatalog { projects: NativeProjectMeta[]; threads: NativeThreadMeta[]; warnings: string[] }
type Row = Record<string, unknown>;
type State = Record<string, unknown>;

function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function parseObject(value: unknown): Row { try { return object(JSON.parse(text(value))); } catch { return {}; } }
function normalizedPath(value: string): string { return value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function pathWithin(child: string, root: string): boolean { const a = normalizedPath(child); const b = normalizedPath(root); return Boolean(b && (a === b || a.startsWith(`${b}/`))); }
function date(milliseconds: unknown, seconds: unknown): string {
  const value = typeof milliseconds === 'number' && milliseconds > 0 ? milliseconds : typeof seconds === 'number' ? seconds * 1000 : 0;
  if (!Number.isFinite(value) || value <= 0) return '';
  try { return new Date(value).toISOString(); } catch { return ''; }
}

function readState(codexHome: string, warnings: string[]): State {
  try { return object(JSON.parse(readFileSync(join(codexHome, '.codex-global-state.json'), 'utf8'))); }
  catch { warnings.push('本机项目归属记录不可用，将尝试匹配已创建项目；未匹配的任务收进“已归档”。'); return {}; }
}
function localProjectMap(state: State, codexHome: string): Row {
  const byHost = object(state['app-server-project-id-by-legacy-project-id-by-host']);
  const entry = Object.entries(byHost).find(([host]) => host.startsWith('local:') && normalizedPath(host.slice(6)) === normalizedPath(codexHome));
  return object(entry?.[1]);
}
function classify(row: Row, edgeParent?: string): { source: NativeThreadSource; parentId?: string } {
  const source = parseObject(row.source); const subagent = object(source.subagent); const spawn = object(subagent.thread_spawn);
  const parentId = edgeParent || text(spawn.parent_thread_id) || undefined;
  if (row.thread_source === 'guardian_review' || subagent.other === 'guardian') return { source: 'guardian', parentId };
  if (row.thread_source === 'subagent' || Object.keys(subagent).length || text(row.agent_path) || parentId) return { source: 'subagent', parentId };
  if (row.thread_source === 'user' || ['vscode', 'cli', 'exec', 'user'].includes(text(row.source))) return { source: 'user' };
  return { source: 'unknown' };
}
function displayTitle(row: Row): string {
  const existing = text(row.name).trim() || text(row.title).trim();
  if (existing) return existing;
  const agentName = text(row.agent_path).split(/[\\/]/).filter(Boolean).at(-1);
  if (agentName) return `子任务 · ${agentName}`;
  const id = text(row.id);
  return `未命名任务 · ${id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}`;
}

/** 仅只读连接 Codex 元数据；不导入、不更新、不重建 Codex 的原始数据库。 */
export function readNativeCatalog(codexHome: string): NativeCatalog {
  const path = join(codexHome, 'state_5.sqlite');
  if (!existsSync(path)) throw new Error(`未找到本机 Codex 元数据：${path}`);
  const warnings: string[] = []; const state = readState(codexHome, warnings);
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new Error('无法只读打开本机 Codex 元数据，请检查 state_5.sqlite 是否可读取。'); }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    if (!tables.has('threads')) throw new Error('本机 Codex 元数据结构不兼容：缺少 threads 表。');
    const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => String(row.name)));
    const required = ['id', 'title', 'cwd', 'source', 'created_at', 'updated_at', 'rollout_path'];
    const missing = required.filter(field => !fields.has(field));
    if (missing.length) throw new Error(`本机 Codex 元数据结构不兼容：缺少字段 ${missing.join(', ')}。`);
    const optional = ['name', 'thread_source', 'agent_path', 'project_id', 'archived', 'created_at_ms', 'updated_at_ms'];
    const rows = db.prepare(`SELECT ${[...required, ...optional.filter(field => fields.has(field))].join(',')} FROM threads ORDER BY updated_at DESC,id`).all() as Row[];
    const edges = new Map<string, string>();
    if (tables.has('thread_spawn_edges')) for (const edge of db.prepare('SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges').all()) edges.set(text(edge.child_thread_id), text(edge.parent_thread_id));
    const mapping = localProjectMap(state, codexHome);
    const projects = new Map<string, NativeProjectMeta>(); const roots: { projectId: string; path: string }[] = [];
    if (tables.has('projects')) {
      for (const row of db.prepare('SELECT id,name FROM projects ORDER BY position,id').all()) projects.set(text(row.id), { id: text(row.id), name: text(row.name), rootPath: '', description: '本机 Codex 项目' });
      if (tables.has('project_roots')) for (const root of db.prepare('SELECT project_id,path FROM project_roots ORDER BY position').all()) {
        const projectId = text(root.project_id); const rootPath = text(root.path); const project = projects.get(projectId);
        if (project && rootPath) { roots.push({ projectId, path: rootPath }); if (!project.rootPath) project.rootPath = rootPath; }
      }
    } else warnings.push('本机元数据没有项目表，正在使用本机保存的项目目录信息。');
    for (const [legacyId, value] of Object.entries(object(state['local-projects']))) {
      const item = object(value); const id = text(mapping[legacyId]) || legacyId; const paths = Array.isArray(item.rootPaths) ? item.rootPaths.filter((p): p is string => typeof p === 'string') : [];
      // 原生项目表是当前项目目录，旧状态不能恢复已删除的项目。
      if (tables.has('projects') && !projects.has(id)) continue;
      if (!projects.has(id)) projects.set(id, { id, name: text(item.name) || (paths[0] ? win32.basename(paths[0]) : '未命名项目'), rootPath: paths[0] || '', description: '本机保存的项目' });
      for (const root of paths) if (!roots.some(known => known.projectId === id && normalizedPath(known.path) === normalizedPath(root))) roots.push({ projectId: id, path: root });
    }
    roots.sort((a, b) => normalizedPath(b.path).length - normalizedPath(a.path).length);
    const assignments = object(state['thread-project-assignments']);
    const projectless = new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'].filter((v): v is string => typeof v === 'string') : []);
    const rowById = new Map(rows.map(row => [text(row.id), row])); const resolved = new Map<string, string>(); const resolving = new Set<string>();
    let staleAssignments = 0;
    function archiveProject(): string {
      const id = 'native:archived';
      if (!projects.has(id)) projects.set(id, { id, name: '已归档', rootPath: '', description: '未关联到当前 Codex 项目的任务' });
      return id;
    }
    function projectFor(row: Row): string {
      const id = text(row.id); const cwd = text(row.cwd); const cached = resolved.get(id); if (cached) return cached;
      if (resolving.has(id)) { warnings.push('检测到循环父任务关系，未匹配项目的任务已收进“已归档”。'); return archiveProject(); }
      resolving.add(id);
      let projectId = ''; const nativeId = text(row.project_id); const assignment = object(assignments[id]);
      if (nativeId && projects.has(nativeId)) projectId = nativeId;
      else if (assignment.projectKind === 'local') {
        const legacyId = text(assignment.projectId); const mapped = text(mapping[legacyId]) || legacyId;
        if (projects.has(mapped)) projectId = mapped;
      }
      if (!projectId && (nativeId || assignment.projectKind === 'local')) { staleAssignments++; projectId = archiveProject(); }
      if (!projectId && projectless.has(id)) projectId = archiveProject();
      if (!projectId) {
        const { parentId } = classify(row, edges.get(id)); const parent = parentId ? rowById.get(parentId) : undefined;
        if (parent && parent !== row) projectId = projectFor(parent);
      }
      if (!projectId) projectId = roots.find(root => pathWithin(cwd, root.path))?.projectId ?? archiveProject();
      resolved.set(id, projectId); resolving.delete(id); return projectId;
    }
    let missingRollouts = 0;
    const threads: NativeThreadMeta[] = rows.map(row => {
      const id = text(row.id); const stored = text(row.rollout_path);
      const rolloutPath = stored && existsSync(stored) ? stored : stored && existsSync(`${stored}.zst`) ? `${stored}.zst` : undefined;
      if (!rolloutPath) missingRollouts++;
      return { id, title: displayTitle(row), cwd: text(row.cwd), projectId: projectFor(row), archived: row.archived === 1,
        ...classify(row, edges.get(id)), createdAt: date(row.created_at_ms, row.created_at), updatedAt: date(row.updated_at_ms, row.updated_at), rolloutPath };
    });
    if (staleAssignments) warnings.push(`${staleAssignments} 个旧项目归属已失效；未找到当前项目的主任务已收进“已归档”。`);
    if (missingRollouts) warnings.push(`${missingRollouts} 个任务的原始日志路径暂不可用；仍保留任务元数据并尝试读取本机正文库。`);
    return { projects: [...projects.values()], threads, warnings: [...new Set(warnings)] };
  } finally { db.close(); }
}
