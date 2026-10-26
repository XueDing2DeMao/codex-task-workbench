import { createHash } from 'node:crypto';
import type { SourceRecord, TaskContent } from '../../shared/contracts.ts';

export class DomainError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message); this.name = 'DomainError'; this.code = code; this.status = status;
  }
}
export function fail(code: string, message: string, status = 400): never { throw new DomainError(code, message, status); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const digest = (value: unknown): string => sha256(canonical(value));
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label}必须为对象`);
  return value as Record<string, unknown>;
}
export function keys(value: unknown, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object(value, label))) if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${label}包含不允许的字段：${key}`);
}
export function text(value: unknown, label: string, blank = false, max = 2_000_000): string {
  if (typeof value !== 'string' || (!blank && !value.trim()) || value.length > max || value.includes('\0')) fail('INVALID_INPUT', `${label}必须为${blank ? '' : '非空'}文本，长度不能超过${max}`);
  return value;
}
export function id(value: unknown, label = 'ID'): string { return text(value, label, false, 512); }
export function array(value: unknown, label: string, max = 100_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_INPUT', `${label}必须为数组，最多${max}项`);
  return value;
}
export function strings(value: unknown, label: string, blank = false): string[] { return array(value, label, 10_000).map(v => text(v, label, blank)); }
export function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) fail('DUPLICATE', `${label}不能重复`); }
export function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) fail('INVALID_INPUT', `${label}值不受支持`);
  return value as T;
}
export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail('INVALID_INPUT', `${label}必须是大于等于${min}的整数`);
  return value;
}
export function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') fail('INVALID_INPUT', `${label}必须为布尔值`); return value; }
export function timestamp(value: unknown, label: string): string { const result = text(value, label); if (!Number.isFinite(Date.parse(result))) fail('INVALID_INPUT', `${label}时间无效`); return result; }

export function validateContent(value: unknown): TaskContent {
  const input = object(value, '任务内容');
  keys(input, ['goal', 'requirements', 'scope', 'nonGoals', 'criteria', 'sourceIds', 'conflicts'], '任务内容');
  const criteria = array(input.criteria, '验收标准', 1000).map(value => {
    const criterion = object(value, '验收项'); keys(criterion, ['id', 'text', 'required'], '验收项');
    return { id: id(criterion.id, '验收项ID'), text: text(criterion.text, '验收项内容'), required: bool(criterion.required, '必选验收项') };
  });
  unique(criteria.map(c => c.id), '验收项ID');
  const sourceIds = strings(input.sourceIds, '来源ID'); unique(sourceIds, '来源ID');
  return { goal: text(input.goal, '目标'), requirements: strings(input.requirements, '要求'), scope: text(input.scope, '范围', true),
    nonGoals: text(input.nonGoals, '非目标', true), criteria, sourceIds, conflicts: strings(input.conflicts, '未解决冲突') };
}

export function validateSource(value: unknown): SourceRecord {
  const s = object(value, '来源记录');
  keys(s, ['id','projectId','sessionId','turnId','eventId','sequence','timestamp','role','sourceKind','attribution','inherited','kind','text','raw','filePath','line','hash','archived','changes','byteOffset','sourceGeneration','parserVersion'], '来源记录');
  const raw = text(s.raw, '原始载荷', true, 30_000_000);
  if (text(s.hash, '来源哈希') !== sha256(raw)) fail('HASH_MISMATCH', '来源原始载荷哈希校验失败');
  const result: SourceRecord = {
    id: id(s.id), projectId: id(s.projectId), sessionId: id(s.sessionId), turnId: text(s.turnId, '轮次ID', true), eventId: id(s.eventId),
    sequence: integer(s.sequence, '顺序'), timestamp: s.timestamp === '' ? '' : timestamp(s.timestamp, '来源时间'), role: text(s.role, '角色'),
    sourceKind: choice(s.sourceKind, ['root','subagent','unknown'], '来源类别'), attribution: choice(s.attribution, ['human','agent','system','unknown'], '作者归属'),
    inherited: bool(s.inherited, '继承标记'), kind: choice(s.kind, ['message','tool','file_change','context'], '事件类别'),
    text: text(s.text, '来源正文', true, 30_000_000), raw, filePath: text(s.filePath, '来源路径', true), line: integer(s.line, '行号'),
    hash: s.hash as string, archived: bool(s.archived, '归档标记'), changes: array(s.changes, '文件变化').map(value => {
      const change = object(value, '文件变化'); keys(change, ['path','diff','status'], '文件变化');
      return { path: text(change.path, '文件路径'), diff: text(change.diff, '历史补丁', true, 30_000_000), status: choice(change.status, ['confirmed','attempted','unknown'], '变更状态') };
    }),
  };
  if (s.byteOffset !== undefined) result.byteOffset = integer(s.byteOffset, '字节位置');
  if (s.sourceGeneration !== undefined) result.sourceGeneration = text(s.sourceGeneration, '来源世代');
  if (s.parserVersion !== undefined) result.parserVersion = text(s.parserVersion, '解析器版本');
  return result;
}

export function sourceFingerprint(source: SourceRecord): string {
  // 文件移动/归档与人工作者判定可以变化；事件身份和原始内容不能变化。
  const { attribution: _a, archived: _b, filePath: _p, line: _l, byteOffset: _o, parserVersion: _v, ...immutable } = source;
  return digest(immutable);
}

const recordValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function resultEnvelope(source: SourceRecord): Record<string, unknown> | null {
  let raw: Record<string, unknown>;
  try { raw = recordValue(JSON.parse(source.raw)); } catch { return null; }
  const payload = recordValue(raw.payload), item = recordValue(payload.item);
  if (source.role !== 'tool') return null;
  if (source.kind === 'tool' && raw.type === 'response_item' && ['function_call_output','custom_tool_call_output'].includes(String(payload.type)) && 'output' in payload) return payload;
  if (raw.type !== 'event_msg') return null;
  if (source.kind === 'file_change' && payload.type === 'patch_apply_end') return payload;
  if (payload.type !== 'item_completed') return null;
  if (source.kind === 'file_change' && item.type === 'FileChange') return item;
  if (source.kind === 'tool' && ['CommandExecution','McpToolCall','Extension','ImageView','WebSearch'].includes(String(item.type))) return item;
  return null;
}
export function isDirectResult(source: SourceRecord): boolean { return resultEnvelope(source) !== null; }

export function explicitFailure(source: SourceRecord): boolean {
  if (source.kind === 'file_change' && (!source.changes.length || source.changes.some(c => c.status !== 'confirmed'))) return true;
  const envelope = resultEnvelope(source); if (!envelope) return true;
  const failed = (value: unknown): boolean => {
    const result = recordValue(value);
    if (result.isError === true || result.success === false || ['failed','failure','interrupted','cancelled','canceled','denied','error'].includes(String(result.status))) return true;
    return ['exit_code','exitCode'].some(key => typeof result[key] === 'number' && result[key] !== 0);
  };
  if (failed(envelope) || failed(envelope.result)) return true;
  // 只识别结果封装，不把测试日志/引用文本中的 exit_code 当作执行退出码。
  const output = envelope.output;
  if (typeof output !== 'string') return failed(output);
  try { return failed(JSON.parse(output)); } catch { /* 兼容 CLI 的纯文本传输头。 */ }
  if (/^(?:Chunk ID:|Wall time:)/.test(output)) {
    const header = output.split(/\r?\n(?:Output:|Final output:)\r?\n/, 1)[0];
    const exit = /(?:^|\r?\n)(?:Exit code:|Process exited with code)\s*(-?\d+)\s*(?:\r?\n|$)/.exec(header);
    return !!exit && Number(exit[1]) !== 0;
  }
  return false;
}
