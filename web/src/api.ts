import type {
  AcceptInput, Acceptance, Assessment, AssessmentInput, Attribution, BackupData, CreateTaskInput,
  Handoff, ImportResult, Overview, Project, Receipt, ReceiptInput, SaveDraftInput, SearchOptions,
  SearchResult, SourceRecord, TaskDetail, TaskListItem,
} from '../../shared/contracts.ts';

export interface Bootstrap {
  csrfToken: string; allowedRoots: string[]; dataDirectory: string; version: string;
  capabilities: { historyMode: 'jsonl'; mcp: false };
}
export interface RestoreResult { projects: number; tasks: number; records: number; restoredDirectory: string; restartRequired: true }

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
  }
}

let csrfToken = '';
let bootstrapPromise: Promise<Bootstrap> | undefined;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET';
  if (method !== 'GET' && !csrfToken) await bootstrap();
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('X-Workbench-Token', csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { throw new ApiError('本地服务返回了无法读取的内容，请检查服务是否已启动。', response.status, 'INVALID_RESPONSE'); }
  if (!response.ok) {
    const problem = data as { message?: string; error?: string } | null;
    throw new ApiError(problem?.message ?? '请求未能完成。', response.status, problem?.error ?? 'REQUEST_FAILED');
  }
  return data as T;
}

function bootstrap(): Promise<Bootstrap> {
  if (!bootstrapPromise) {
    bootstrapPromise = request<Bootstrap>('/bootstrap').then(data => { csrfToken = data.csrfToken; return data; })
      .catch(error => { bootstrapPromise = undefined; throw error; });
  }
  return bootstrapPromise;
}

function query(values: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
const id = encodeURIComponent;
const body = (value: unknown) => JSON.stringify(value);

export const api = {
  bootstrap,
  overview: (signal?: AbortSignal) => request<Overview>('/overview', { signal }),
  projects: (signal?: AbortSignal) => request<Project[]>('/projects', { signal }),
  createProject: (input: { name: string; rootPath?: string }) => request<Project>('/projects', { method: 'POST', body: body(input) }),
  importHistory: (projectId: string, paths: string[]) => request<ImportResult>('/sources/import', { method: 'POST', body: body({ projectId, paths }) }),
  search: (options: SearchOptions, signal?: AbortSignal) => request<SearchResult>(`/search${query(options)}`, { signal }),
  record: (recordId: string, signal?: AbortSignal) => request<SourceRecord>(`/records/${id(recordId)}`, { signal }),
  recordContext: (recordId: string, signal?: AbortSignal) => request<SourceRecord[]>(`/records/${id(recordId)}/context`, { signal }),
  context: (sessionId: string, limit: number, offset: number, signal?: AbortSignal) => request<SourceRecord[]>(`/sessions/${id(sessionId)}/records${query({ limit, offset })}`, { signal }),
  classify: (recordId: string, attribution: Attribution) => request<SourceRecord>(`/records/${id(recordId)}/attribution`, { method: 'POST', body: body({ attribution }) }),
  tasks: (options: { projectId?: string; archived?: boolean; q?: string }, signal?: AbortSignal) => request<TaskListItem[]>(`/tasks${query(options)}`, { signal }),
  task: (taskId: string, signal?: AbortSignal) => request<TaskDetail>(`/tasks/${id(taskId)}`, { signal }),
  createTask: (input: CreateTaskInput) => request<TaskDetail>('/tasks', { method: 'POST', body: body(input) }),
  saveDraft: (taskId: string, input: SaveDraftInput) => request<TaskDetail>(`/tasks/${id(taskId)}/draft`, { method: 'PUT', body: body(input) }),
  activate: (taskId: string, expectedVersion: number) => request<TaskDetail>(`/tasks/${id(taskId)}/activate`, { method: 'POST', body: body({ expectedVersion }) }),
  archive: (taskId: string, archived: boolean, expectedVersion: number) => request<TaskDetail>(`/tasks/${id(taskId)}/archive`, { method: 'POST', body: body({ archived, expectedVersion }) }),
  handoff: (input: { purpose: 'organize' | 'execute'; taskId?: string; revisionId?: string; sourceIds?: string[] }) => request<Handoff>('/handoffs', { method: 'POST', body: body(input) }),
  receipt: (input: ReceiptInput) => request<Receipt>('/receipts', { method: 'POST', body: body(input) }),
  assess: (input: AssessmentInput) => request<Assessment>('/assessments', { method: 'POST', body: body(input) }),
  accept: (input: AcceptInput) => request<Acceptance>('/acceptances', { method: 'POST', body: body(input) }),
  exportTask: (taskId: string) => request<{ markdown: string; json: TaskDetail }>(`/tasks/${id(taskId)}/export`),
  backup: () => request<BackupData>('/backup'),
  restore: (data: BackupData) => request<RestoreResult>('/restore', { method: 'POST', body: body(data) }),
};
