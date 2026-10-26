import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { HistoryBatch, Diagnostic, SourceRecord } from '../../shared/contracts.ts';
import { hash, object, PARSER_VERSION, projectRecord, sourceKind } from './records.ts';
import type { JsonObject } from './records.ts';

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
interface PhysicalLine { raw: string; hash: string; offset: number; line: number; value: JsonObject }
interface ParsedFile { path: string; bytes: Buffer; hash: string; lines: PhysicalLine[]; meta: JsonObject; generation: string }
const within = (root: string, path: string) => { const rel = relative(root, path); return !rel || !rel.startsWith('..') && !isAbsolute(rel); };

export async function importHistoryPaths(paths: string[], projectId: string): Promise<HistoryBatch> {
  const batch: HistoryBatch = { records: [], diagnostics: [], files: [] };
  const found = new Set<string>();
  const allowedRoots = new Map<string, string>();
  const visited = new Set<string>();
  const add = (code: string, message: string, filePath?: string, severity: Diagnostic['severity'] = 'warning') => batch.diagnostics.push({ code, message, filePath, severity });
  async function discover(path: string, root?: string): Promise<void> {
    if (found.size >= MAX_FILES) { add('fileLimit', `最多导入 ${MAX_FILES} 个文件，剩余范围未读取。`, path); return; }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) { add('symlinkSkipped', '跳过符号链接，未读取链接目标。', path); return; }
      const physical = await realpath(path);
      if (root && !within(root, physical)) { add('outsideRoot', '真实路径超出用户选定根，已跳过。', path); return; }
      if (visited.has(physical)) return;
      visited.add(physical);
      if (info.isDirectory()) {
        for (const entry of (await readdir(physical)).sort()) await discover(join(physical, entry), root || physical);
      } else if (info.isFile() && /\.jsonl$/iu.test(physical)) { found.add(physical); allowedRoots.set(physical, root || physical); }
      else if (!root) add('unsupportedFile', '只支持选定的 JSONL 文件或包含 JSONL 的目录。', physical);
    } catch { add('unreadableFile', '路径不存在或不可读取。', path, 'error'); }
  }
  for (const path of paths) await discover(resolve(path));
  const parsed: ParsedFile[] = [];
  let totalBytes = 0;
  for (const path of found) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) { add('sourceChanged', '来源类型在枚举后改变，未导入。', path); continue; }
      if (!within(allowedRoots.get(path)!, await realpath(path))) { add('outsideRoot', '读取前真实路径已越出选定根，未导入。', path); continue; }
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) { add('sizeLimit', '超出单文件 64 MiB 或本批次 256 MiB 限制，未导入。', path); continue; }
      const bytes = await readFile(path);
      totalBytes += bytes.length;
      const lines: PhysicalLine[] = [];
      let offset = 0; let line = 1;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const next = newline < 0 ? bytes.length : newline + 1;
        const end = (newline < 0 ? bytes.length : newline) - (bytes[(newline < 0 ? bytes.length : newline) - 1] === 13 ? 1 : 0);
        const slice = bytes.subarray(offset, end);
        let raw = '';
        try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice); }
        catch { add(newline < 0 ? 'incompleteTail' : 'invalidUtf8', `第 ${line} 行 UTF-8 不完整或无效，原文件未改变。`, path); offset = next; line++; continue; }
        if (raw.trim()) {
          try {
            const value = JSON.parse(raw.replace(/^\uFEFF/u, ''));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
            lines.push({ raw, hash: hash(slice), offset, line, value });
          } catch { add(newline < 0 ? 'incompleteTail' : 'malformedJson', `第 ${line} 行未解析，原文件未改变。`, path); }
        }
        offset = next; line++;
      }
      const fileHash = hash(bytes);
      if (hash(await readFile(path)) !== fileHash) { add('sourceChanged', '读取期间来源发生变化，请重新扫描；本文件未提交。', path); continue; }
      const firstMeta = lines.find(row => row.value.type === 'session_meta');
      const meta = object(firstMeta?.value.payload);
      if (!meta.id) add('missingSessionMeta', '缺少可信首会话身份，使用文件来源身份。', path);
      if (meta.history_mode === 'paginated') add('physicalCoverageOnly', '只读取当前物理 JSONL；未验证官方分页完整性，不能声明完整历史。', path, 'info');
      parsed.push({ path, bytes, hash: fileHash, lines, meta, generation: firstMeta?.hash || hash(lines[0]?.raw || path) });
      batch.files.push({ path, hash: fileHash, bytes: bytes.length });
    } catch { add('unreadableFile', '读取文件失败，未导入该文件。', path, 'error'); }
  }
  const identities = new Map<string, ParsedFile[]>();
  for (const file of parsed) if (file.meta.id) identities.set(file.meta.id, [...(identities.get(file.meta.id) || []), file]);
  const emitted = new Set<string>();
  for (const file of parsed) {
    let ancestor = file.meta.id;
    const chain = new Set<string>();
    while (typeof ancestor === 'string' && ancestor && chain.size < 64) {
      if (chain.has(ancestor)) { add('historyCycle', '父会话引用构成循环；未展开或补造继承记录。', file.path); break; }
      chain.add(ancestor);
      const candidates = identities.get(ancestor) || [];
      if (candidates.length !== 1) break;
      ancestor = object(candidates[0].meta.history_base).thread_id;
    }
    if (chain.size >= 64) add('historyDepthLimit', '父引用超过 64 层，仅报告，未继续展开。', file.path);
    const parentId = object(file.meta.history_base).thread_id;
    if (parentId) {
      const parents = identities.get(parentId) || [];
      add(!parents.length ? 'missingParent' : parents.length > 1 ? 'ambiguousParent' : 'parentHistoryNotExpanded', !parents.length ? 'history_base 父身份未包含在本次输入中，继承历史不完整。' : '父引用已发现；当前版本保留引用但不跨文件补齐分页边界。', file.path);
    }
    const sessionId = typeof file.meta.id === 'string' ? file.meta.id : `file:${hash(file.path)}`;
    let segment = sessionId; let currentTurn = ''; let inherited = false;
    const occurrences = new Map<string, number>();
    const unknown = new Map<string, number>();
    for (const row of file.lines) {
      const value = row.value; const payload = object(value.payload); const item = object(payload.item);
      if (value.type === 'session_meta' && typeof payload.id === 'string') { segment = payload.id; inherited = segment !== sessionId; }
      if ((value.type === 'inter_agent_communication_metadata' && payload.trigger_turn === true) || payload.thread_id === sessionId) {
        segment = sessionId; inherited = false;
      }
      if (typeof payload.turn_id === 'string') currentTurn = payload.turn_id;
      const projected = projectRecord(value);
      const eventKey = typeof payload.id === 'string' ? payload.id : typeof item.id === 'string' ? item.id : typeof value.id === 'string' ? value.id : typeof payload.call_id === 'string' ? payload.call_id : '';
      const category = `${value.type}:${payload.type || ''}:${item.type || ''}`;
      const occurrenceKey = `${segment}:${category}:${row.hash}`;
      const occurrence = occurrences.get(occurrenceKey) || 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const eventId = eventKey ? `${category}:${eventKey}` : `${category}:${row.hash}:${occurrence}`;
      const id = `src_${hash(`${projectId}:${sessionId}:${file.generation}:${eventId}:${row.hash}:${eventKey ? '' : occurrence}`)}`;
      if (emitted.has(id)) continue;
      emitted.add(id);
      const record: SourceRecord = {
        id, projectId, sessionId, turnId: currentTurn, eventId, sequence: row.line, timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
        role: projected.role, sourceKind: sourceKind(file.meta), attribution: projected.role === 'user' || projected.role === 'unknown' ? 'unknown' : ['assistant', 'tool'].includes(projected.role) ? 'agent' : 'system',
        inherited: typeof payload.thread_id === 'string' ? payload.thread_id !== sessionId : inherited,
        kind: projected.kind, text: projected.text, raw: row.raw, filePath: file.path, line: row.line, hash: row.hash,
        archived: file.path.split(/[\\/]/u).some(part => part.toLowerCase() === 'archived_sessions'), changes: projected.changes,
        byteOffset: row.offset, sourceGeneration: file.generation, parserVersion: PARSER_VERSION,
      };
      batch.records.push(record);
      if (!projected.known) unknown.set(category, (unknown.get(category) || 0) + 1);
    }
    if (segment !== sessionId) add('inheritanceBoundaryUnknown', '存在不同身份的内嵌元数据，但未找到返回当前会话的明确标记；继承归属需核对。', file.path);
    if (unknown.size) add('unknownEvent', `未识别事件已保留原文：${[...unknown].map(([kind, count]) => `${kind} × ${count}`).join('；')}`, file.path);
  }
  return batch;
}
