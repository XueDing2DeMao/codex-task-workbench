import type { Assessment, Receipt, TaskContent } from '../../shared/contracts.ts';

export type CriterionState = 'unverified' | 'passed' | 'failed' | 'blocked' | 'conflict';
export function activeAssessments(assessments: Assessment[], revisionId: string, snapshotId: string, criterionId: string): Assessment[] {
  const relevant = assessments.filter(item => item.revisionId === revisionId && item.snapshotId === snapshotId && item.criterionId === criterionId);
  const replaced = new Set(relevant.flatMap(item => item.supersedes ?? []));
  return relevant.filter(item => !replaced.has(item.id));
}
export function latestReceipt(receipts: Receipt[], revisionId: string, snapshotId?: string): Receipt | undefined {
  return receipts.filter(item => item.revisionId === revisionId && (snapshotId === undefined || item.snapshotId === snapshotId)).reduce<Receipt | undefined>((latest, item) => !latest || Date.parse(item.createdAt) >= Date.parse(latest.createdAt) ? item : latest, undefined);
}
export function criterionState(assessments: Assessment[], revisionId: string, snapshotId: string, criterionId: string, receipts?: Receipt[]): CriterionState {
  const latest = receipts ? latestReceipt(receipts, revisionId, snapshotId) : undefined;
  if (receipts && !latest) return 'unverified';
  if (latest && latest.status !== 'completed') return 'blocked';
  const active = activeAssessments(assessments, revisionId, snapshotId, criterionId);
  if (!active.length) return 'unverified';
  const states = new Set(active.map(item => item.result));
  if (states.size === 1 && states.has('passed') && latest && !active.some(item => Date.parse(item.createdAt) > Date.parse(latest.createdAt))) return 'unverified';
  return states.size > 1 ? 'conflict' : active[0].result;
}

function isContent(value: unknown): value is TaskContent {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return ['goal', 'scope', 'nonGoals'].every(key => typeof data[key] === 'string')
    && ['requirements', 'sourceIds', 'conflicts'].every(key => Array.isArray(data[key]) && (data[key] as unknown[]).every(item => typeof item === 'string'))
    && Array.isArray(data.criteria) && data.criteria.every(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.required === 'boolean');
}
export function readOrganizedDraft(json: string): { content: TaskContent; handoffId: string; suggestions: string[]; title?: string } {
  const payload: unknown = JSON.parse(json);
  if (!payload || typeof payload !== 'object') throw new Error('整理结果应为 JSON 对象。');
  const data = payload as Record<string, unknown>;
  if (typeof data.handoffId !== 'string' || !data.handoffId.trim()) throw new Error('导入的整理结果必须包含非空 handoffId，以核对交接包、版本和来源范围。');
  if (!isContent(data.content)) throw new Error('请提供完整 content：目标、要求、范围、验收标准和来源。');
  if (!Array.isArray(data.suggestions) || !data.suggestions.every(item => typeof item === 'string')) throw new Error('整理结果必须包含 suggestions 文本数组；没有新增建议时填写 []。');
  const suggestions = [...new Set(data.suggestions as string[])];
  return { handoffId: data.handoffId.trim(), content: { ...data.content, requirements: data.content.requirements.filter(item => !suggestions.includes(item)) }, suggestions, title: typeof data.title === 'string' ? data.title : undefined };
}

export function emptyContent(sourceIds: string[] = []): TaskContent {
  return { goal: '', requirements: [], scope: '', nonGoals: '', criteria: [{ id: 'AC-01', text: '', required: true }], sourceIds, conflicts: [] };
}
export const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function shortId(value: string) { return value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
export function safeFilename(value: string) { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80) || '任务'; }

export const labels: Record<string, string> = {
  unverified: '未验证', passed: '证据支持通过', failed: '失败', blocked: '受阻', conflict: '存在冲突',
  pending: '未验收', accepted: '已验收', returned: '已退回', completed: '执行结束', interrupted: '已中断',
  human: '本人确认', agent: '代理来源', system: '系统上下文', unknown: '来源待确认', root: '主会话', subagent: '子代理',
  source: '原始记录', artifact: '产物证据', observation: '人工观察', agent_report: '代理自述',
  confirmed: '已确认修改', attempted: '尝试修改', organize: '整理包', execute: '执行包',
};
