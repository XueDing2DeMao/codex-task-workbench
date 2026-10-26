import { createHash } from 'node:crypto';
import type { FileChange, SourceRecord, SourceKind } from '../../shared/contracts.ts';

export const PARSER_VERSION = 'workbench-jsonl-1';
export type JsonObject = Record<string, any>;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value: unknown) => typeof value === 'string' ? value : '';

// 独立实现，仅按已验证的 Codex 封装做保守投影；不执行工具、HTML 或附件。
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => string(object(part).text)).join('');
  const candidate = object(value);
  return string(candidate.text) || (Array.isArray(candidate.content) ? contentText(candidate.content) : '');
}

export function sourceKind(meta: JsonObject): SourceKind {
  if (object(meta.source).subagent && typeof object(meta.source).subagent === 'object') return 'subagent';
  return ['vscode', 'cli', 'exec', 'app', 'app-server', 'mcp', 'api'].includes(meta.source) ? 'root' : 'unknown';
}

const contextTags = new Set(['environment_context', 'user_instructions', 'instructions', 'permissions instructions', 'collaboration_mode', 'skills_instructions', 'apps_instructions', 'plugins_instructions', 'multi_agent_mode', 'recommended_plugins', 'turn_aborted', 'external_codex_apps_open_page']);
export function isContextText(value: string): boolean {
  let rest = value.trim().replace(/^# AGENTS\.md instructions[^\r\n]*(?:\r?\n|$)/iu, '').trim();
  let consumed = false;
  while (rest) {
    const tag = /^<([^<>]+)>/u.exec(rest)?.[1]?.toLowerCase();
    if (!tag || !contextTags.has(tag)) return false;
    const end = rest.toLowerCase().indexOf(`</${tag}>`, tag.length + 2);
    if (end < 0) return false;
    rest = rest.slice(end + tag.length + 3).trim();
    consumed = true;
  }
  return consumed;
}

function changeStatus(event: JsonObject, item: JsonObject): FileChange['status'] {
  const status = string(item.status || event.status).toLowerCase();
  if (item.success === false || event.success === false || ['failed', 'failure', 'cancelled', 'canceled', 'interrupted', 'denied', 'error'].includes(status)) return 'attempted';
  if (status === 'completed' || item.success === true || event.success === true) return 'confirmed';
  return 'unknown';
}

function addedDiff(path: string, content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `--- /dev/null\n+++ ${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}`;
}

export function readChanges(payload: JsonObject, item: JsonObject): FileChange[] {
  const changes = item.changes ?? payload.changes;
  const entries = Array.isArray(changes)
    ? changes.map(change => [string(object(change).path), object(change)] as const)
    : Object.entries(object(changes)).map(([path, change]) => [path, object(change)] as const);
  const status = changeStatus(payload, item);
  return entries.filter(([path]) => path).map(([path, change]) => ({
    path,
    diff: string(change.diff) || string(change.unified_diff) || (change.type === 'add' && typeof change.content === 'string' ? addedDiff(path, change.content) : string(change.content)),
    status,
  }));
}

function patchAttempts(payload: JsonObject): FileChange[] {
  if (!/(?:^|[.:])apply_patch$/u.test(string(payload.name))) return [];
  const text = string(payload.input) || string(payload.arguments);
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => ({ path: match[1].trim(), diff: text, status: 'attempted' }));
}

interface Projection { role: string; kind: SourceRecord['kind']; text: string; changes: FileChange[]; known: boolean }
export function projectRecord(record: JsonObject): Projection {
  const payload = object(record.payload);
  const item = object(payload.item);
  const result: Projection = { role: 'system', kind: 'context', text: '', changes: [], known: true };
  if (record.type === 'response_item' && payload.type === 'message') {
    result.role = string(payload.role) || 'unknown';
    result.text = contentText(payload.content);
    result.kind = ['system', 'developer'].includes(result.role) || isContextText(result.text) ? 'context' : 'message';
  } else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
    result.role = payload.type === 'user_message' ? 'user' : 'assistant';
    result.text = string(payload.message) || contentText(payload.content);
    result.kind = isContextText(result.text) ? 'context' : 'message';
  } else if (record.type === 'response_item' && ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    result.role = 'tool'; result.kind = 'tool';
    result.text = string(payload.input) || string(payload.arguments) || contentText(payload.output) || JSON.stringify(payload.output ?? '');
    result.changes = patchAttempts(payload);
  } else if (record.type === 'event_msg' && (payload.type === 'patch_apply_end' || payload.type === 'item_completed' && item.type === 'FileChange')) {
    result.role = 'tool'; result.kind = 'file_change';
    result.changes = readChanges(payload, item);
    result.text = result.changes.map(change => `${change.path}\n${change.diff}`).join('\n');
  } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
    if (item.type === 'AgentMessage') {
      result.role = 'assistant'; result.kind = 'message'; result.text = contentText(item.content) || string(item.text);
    } else if (item.type !== 'Reasoning') {
      result.role = 'tool'; result.kind = 'tool';
      result.text = [string(item.command), string(item.aggregated_output), contentText(item.output), string(item.stdout), string(item.stderr)].filter(Boolean).join('\n');
      result.known = ['CommandExecution', 'McpToolCall', 'Extension', 'SubAgentActivity', 'ImageView', 'WebSearch'].includes(item.type);
    }
  } else {
    result.known = ['session_meta', 'world_state', 'turn_context', 'token_usage_record', 'inter_agent_communication_metadata', 'compacted'].includes(record.type)
      || record.type === 'response_item' && ['reasoning', 'additional_tools', 'agent_message'].includes(payload.type)
      || record.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted', 'token_count', 'thread_settings_applied', 'context_compacted', 'session_configured'].includes(payload.type);
  }
  return result;
}
