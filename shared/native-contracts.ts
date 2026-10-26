// 本机 Codex 的只读浏览协议；不改写 Codex 或工作台持久化数据。
export type NativeTaskSource = 'user' | 'subagent' | 'guardian' | 'unknown';
export interface NativeProject {
  id: string; name: string; rootPath: string; description: string; taskCount: number;
}
export interface NativeTaskSummary {
  id: string; projectId: string; title: string; summary: string;
  createdAt: string; updatedAt: string; archived: boolean; source: NativeTaskSource;
  parentId?: string; turnCount: number; outputCount: number;
  availability: 'available' | 'empty' | 'unavailable';
  matchExcerpt?: string;
  matchTurnId?: string;
}
export interface NativeOutput { id: string; text: string }
export interface NativeExchange {
  id: string; requirements: string[]; outputs: NativeOutput[]; createdAt?: string; status?: string;
}
export interface NativeTaskDetail extends NativeTaskSummary { exchanges: NativeExchange[] }
export interface NativeCoverage {
  catalogTasks: number; loadedTasks: number; emptyTasks: number; unavailableTasks: number;
  turns: number; requirements: number; outputs: number; archivedTasks: number; subagentTasks: number;
  readAt: string; source: string; warnings: string[];
}
export interface NativeCatalog {
  projects: NativeProject[]; tasks: NativeTaskSummary[]; coverage: NativeCoverage;
}
export interface NativeSearchResult {
  query: string; projects: NativeProject[]; tasks: NativeTaskSummary[]; total: number; readAt: string;
}

export interface NativeExportRequest {
  projectId: string;
  scope: 'project' | 'tasks';
  taskIds?: string[];
  includeRelated: boolean;
}
export interface NativeExportResult {
  filename: string;
  markdown: string;
  readAt: string;
  taskCount: number;
}
export interface NativeExchangeExportRequest {
  taskId: string;
  exchangeId: string;
}
