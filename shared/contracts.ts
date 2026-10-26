export type Attribution = 'human' | 'agent' | 'system' | 'unknown';
export type SourceKind = 'root' | 'subagent' | 'unknown';
export interface Project { id: string; name: string; rootPath: string; createdAt: string }
export interface FileChange { path: string; diff: string; status: 'confirmed' | 'attempted' | 'unknown' }
export interface SourceRecord {
  id: string; projectId: string; sessionId: string; turnId: string; eventId: string;
  sequence: number; timestamp: string; role: string; sourceKind: SourceKind;
  attribution: Attribution; inherited: boolean; kind: 'message' | 'tool' | 'file_change' | 'context';
  text: string; raw: string; filePath: string; line: number; hash: string; archived: boolean;
  changes: FileChange[];
  byteOffset?: number; sourceGeneration?: string; parserVersion?: string;
}
export interface Diagnostic { code: string; message: string; filePath?: string; severity: 'info' | 'warning' | 'error' }
export interface HistoryBatch { records: SourceRecord[]; diagnostics: Diagnostic[]; files: { path: string; hash: string; bytes: number }[] }
export interface ImportResult { inserted: number; skipped: number; diagnostics: Diagnostic[]; files: number }
export interface SearchOptions { q?: string; projectId?: string; scope?: 'instructions' | 'all' | 'tasks' | 'results'; archived?: boolean; attribution?: Attribution; limit?: number; offset?: number }
export interface SearchHit { id: string; type: 'source' | 'task'; title: string; text: string; projectId: string; timestamp: string; source?: SourceRecord; taskId?: string; revisionId?: string; current?: boolean }
export interface SearchResult { items: SearchHit[]; total: number }
export interface Criterion { id: string; text: string; required: boolean }
export interface TaskContent { goal: string; requirements: string[]; scope: string; nonGoals: string; criteria: Criterion[]; sourceIds: string[]; conflicts: string[] }
export interface Task { id: string; projectId: string; title: string; currentRevisionId: string | null; lockVersion: number; archived: boolean; createdAt: string; updatedAt: string }
export interface Revision { id: string; taskId: string; number: number; content: TaskContent; createdAt: string; parentId: string | null }
export interface Draft { taskId: string; content: TaskContent; basedOn: string | null; updatedAt: string }
export interface Handoff { id: string; purpose: 'organize' | 'execute'; taskId: string | null; revisionId: string | null; contentHash: string; sourceIds: string[]; content: unknown; createdAt: string; instruction: string }
export interface EvidenceInput { id: string; criterionId: string; kind: 'source' | 'artifact' | 'observation' | 'agent_report'; sourceId?: string; text: string; snapshotId: string; hash?: string }
export interface ReceiptInput { receiptId: string; runId: string; handoffId: string; taskId: string; revisionId: string; status: 'completed' | 'failed' | 'interrupted'; summary: string; snapshotId: string; evidence: EvidenceInput[] }
export interface Receipt extends ReceiptInput { createdAt: string; hash: string }
export interface AssessmentInput { taskId: string; revisionId: string; criterionId: string; snapshotId: string; evidenceIds: string[]; result: 'passed' | 'failed' | 'blocked'; reason: string; supersedes?: string[] }
export interface Assessment extends AssessmentInput { id: string; actor: 'human'; createdAt: string }
export interface Acceptance { id: string; taskId: string; revisionId: string; snapshotId: string; decision: 'accepted' | 'returned'; reason: string; createdAt: string; actor: 'human' }
export interface AuditEvent { id: string; taskId?: string; action: string; detail: string; createdAt: string }
export interface TaskDetail { task: Task; revisions: Revision[]; draft: Draft | null; handoffs: Handoff[]; receipts: Receipt[]; assessments: Assessment[]; acceptances: Acceptance[]; audit: AuditEvent[] }
export interface TaskListItem extends Task { revisionNumber: number; verification: 'unverified' | 'passed' | 'failed' | 'blocked'; acceptance: 'pending' | 'accepted' | 'returned'; hasDraft: boolean }
export interface Overview { projects: number; records: number; tasks: number; drafts: number; pendingAcceptance: number; unknownSources: number; diagnostics: Diagnostic[] }
export interface CreateTaskInput { projectId: string; title: string; content: TaskContent; handoffId?: string; adoptedSuggestions?: string[] }
export interface SaveDraftInput { content: TaskContent; expectedVersion: number; adoptedSuggestions?: string[]; handoffId?: string }
export interface AcceptInput { taskId: string; revisionId: string; snapshotId: string; decision: 'accepted' | 'returned'; reason: string }
export interface BackupData { format: 'codex-task-workbench'; version: 1; createdAt: string; payload: Record<string, unknown[]>; hash: string }
export interface StoreApi {
  close(): void;
  getOverview(): Overview;
  listProjects(): Project[];
  createProject(input: { name: string; rootPath?: string }): Project;
  importHistory(projectId: string, batch: HistoryBatch): ImportResult;
  search(options: SearchOptions): SearchResult;
  getRecord(id: string): SourceRecord;
  getRecordContext(id: string, before?: number, after?: number): SourceRecord[];
  listRecords(sessionId: string, limit?: number, offset?: number): SourceRecord[];
  classifyRecord(id: string, attribution: Attribution): SourceRecord;
  createTask(input: CreateTaskInput): TaskDetail;
  listTasks(options?: { projectId?: string; archived?: boolean; q?: string }): TaskListItem[];
  getTask(id: string): TaskDetail;
  saveDraft(id: string, input: SaveDraftInput): TaskDetail;
  activateDraft(id: string, expectedVersion: number): TaskDetail;
  setArchived(id: string, archived: boolean, expectedVersion: number): TaskDetail;
  createHandoff(input: { purpose: 'organize' | 'execute'; taskId?: string; revisionId?: string; sourceIds?: string[] }): Handoff;
  submitReceipt(input: ReceiptInput): Receipt;
  addAssessment(input: AssessmentInput): Assessment;
  acceptTask(input: AcceptInput): Acceptance;
  exportTask(id: string): { markdown: string; json: TaskDetail };
  createBackup(): BackupData;
  restoreBackup(data: BackupData): { projects: number; tasks: number; records: number };
}
