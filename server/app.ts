import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { StoreApi, BackupData, ReceiptInput, AssessmentInput, AcceptInput, CreateTaskInput, SaveDraftInput, Attribution } from '../shared/contracts.ts';
import { ApiError, assertAllowedKeys, isWithin, validateImportPaths, validateLocalHost, validateRequest } from './security.ts';
import type { NativeReader } from './native/service.ts';
import type { NativeExchangeExportRequest, NativeExportRequest } from '../shared/native-contracts.ts';

export interface AppOptions { store: StoreApi; dataDirectory: string; allowedRoots: string[]; webRoot: string; onShutdown?: () => void; nativeReader?: NativeReader }
const allowedReceipt = ['receiptId', 'runId', 'handoffId', 'taskId', 'revisionId', 'status', 'summary', 'snapshotId', 'evidence'];

async function body(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ApiError(413, '导入数据超过允许大小');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'JSON 格式无效，请检查导入内容'); }
}
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function integer(query: URLSearchParams, name: string, fallback: number, max: number): number {
  const value = query.get(name); if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new ApiError(400, `无效分页参数 ${name}`);
  return number;
}

export function createApp(options: AppOptions) {
  const { store } = options;
  const secret = randomBytes(32).toString('hex');
  const clients = new Set<ServerResponse>();
  const changed = () => { for (const res of clients) res.write(`event: changed\ndata: {}\n\n`); };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname; const method = req.method ?? 'GET'; const q = url.searchParams;
    const bootstrap = path === '/api/bootstrap' && method === 'GET';
    validateRequest(req, secret, bootstrap);
    if (bootstrap) {
      res.setHeader('Set-Cookie', `ctw_session_${req.socket.localPort}=${secret}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, { application: 'codex-task-workbench', csrfToken: secret, allowedRoots: options.allowedRoots, dataDirectory: options.dataDirectory, version: '1.0.0', capabilities: { historyMode: 'jsonl', mcp: false } });
    }
    if (path === '/api/shutdown' && method === 'POST' && options.onShutdown) {
      const input = await body(req); assertAllowedKeys(input, []);
      json(res, { stopping: true }); setImmediate(options.onShutdown); return;
    }
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n'); clients.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
      req.on('close', () => { clearInterval(heartbeat); clients.delete(res); }); return;
    }
    let result: unknown; let mutated = false;
    if (path === '/api/native/export/exchange' && method === 'POST') {
      if (!options.nativeReader) throw new ApiError(503, '本机 Codex 读取尚未启用，请重启本地服务');
      const input = await body(req);
      assertAllowedKeys(input, ['taskId', 'exchangeId']);
      result = await options.nativeReader.exportExchange(input as unknown as NativeExchangeExportRequest);
    } else if (path === '/api/native/export/markdown' && method === 'POST') {
      if (!options.nativeReader) throw new ApiError(503, '本机 Codex 读取尚未启用，请重启本地服务');
      const input = await body(req);
      assertAllowedKeys(input, ['projectId', 'scope', 'taskIds', 'includeRelated']);
      result = await options.nativeReader.exportMarkdown(input as unknown as NativeExportRequest);
    } else if (path.startsWith('/api/native/') && method === 'GET') {
      if (!options.nativeReader) throw new ApiError(503, '本机 Codex 读取尚未启用，请重启本地服务');
      if (path === '/api/native/catalog') result = await options.nativeReader.catalog(q.get('refresh') === '1');
      else if (path === '/api/native/search') {
        const query = q.get('q') ?? '';
        if (query.length > 150) throw new ApiError(400, '搜索关键词过长');
        result = await options.nativeReader.search(query);
      } else if (/^\/api\/native\/tasks\/[^/]+$/.test(path)) result = await options.nativeReader.task(decodeURIComponent(path.split('/')[4]));
      else throw new ApiError(404, '找不到这个接口');
    } else if (path === '/api/overview' && method === 'GET') result = store.getOverview();
    else if (path === '/api/projects' && method === 'GET') result = store.listProjects();
    else if (path === '/api/projects' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['name', 'rootPath']);
      result = store.createProject(input as { name: string; rootPath?: string }); mutated = true;
    } else if (path === '/api/sources/import' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['projectId', 'paths']);
      if (typeof input.projectId !== 'string' || !store.listProjects().some(p => p.id === input.projectId)) throw new ApiError(400, '请选择有效项目');
      const paths = await validateImportPaths(input.paths, options.allowedRoots);
      const { importHistoryPaths } = await import('./history/importer.ts');
      const batch = await importHistoryPaths(paths, input.projectId);
      result = store.importHistory(input.projectId, batch); mutated = true;
    } else if (path === '/api/search' && method === 'GET') {
      const scope = q.get('scope') ?? 'instructions';
      if (!['instructions', 'all', 'tasks', 'results'].includes(scope)) throw new ApiError(400, '搜索范围无效');
      const attribution = q.get('attribution') || undefined;
      if (attribution && !['human', 'agent', 'system', 'unknown'].includes(attribution)) throw new ApiError(400, '来源筛选无效');
      result = store.search({ q: q.get('q') ?? '', projectId: q.get('projectId') || undefined, scope: scope as 'instructions', archived: q.get('archived') !== 'false', attribution: attribution as Attribution | undefined, limit: integer(q, 'limit', 50, 200), offset: integer(q, 'offset', 0, 1_000_000) });
    } else if (/^\/api\/records\/[^/]+\/context$/.test(path) && method === 'GET') result = store.getRecordContext(decodeURIComponent(path.split('/')[3]), 4, 6);
    else if (/^\/api\/records\/[^/]+$/.test(path) && method === 'GET') result = store.getRecord(decodeURIComponent(path.split('/')[3]));
    else if (/^\/api\/records\/[^/]+\/attribution$/.test(path) && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['attribution']);
      if (!['human', 'agent', 'system', 'unknown'].includes(String(input.attribution))) throw new ApiError(400, '来源归属无效');
      result = store.classifyRecord(decodeURIComponent(path.split('/')[3]), input.attribution as Attribution); mutated = true;
    } else if (/^\/api\/sessions\/[^/]+\/records$/.test(path) && method === 'GET') {
      result = store.listRecords(decodeURIComponent(path.split('/')[3]), integer(q, 'limit', 50, 200), integer(q, 'offset', 0, 1_000_000));
    } else if (path === '/api/tasks' && method === 'GET') result = store.listTasks({ projectId: q.get('projectId') || undefined, archived: q.get('archived') === 'true', q: q.get('q') || undefined });
    else if (path === '/api/tasks' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['projectId', 'title', 'content', 'handoffId', 'adoptedSuggestions']);
      result = store.createTask(input as unknown as CreateTaskInput); mutated = true;
    } else if (/^\/api\/tasks\/[^/]+(?:\/(draft|activate|archive|export))?$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3]); const action = path.split('/')[4];
      if (!action && method === 'GET') result = store.getTask(id);
      else if (action === 'export' && method === 'GET') result = store.exportTask(id);
      else if (action === 'draft' && method === 'PUT') {
        const input = await body(req); assertAllowedKeys(input, ['content', 'expectedVersion', 'adoptedSuggestions', 'handoffId']);
        result = store.saveDraft(id, input as unknown as SaveDraftInput); mutated = true;
      } else if (action === 'activate' && method === 'POST') {
        const input = await body(req); assertAllowedKeys(input, ['expectedVersion']);
        result = store.activateDraft(id, input.expectedVersion as number); mutated = true;
      } else if (action === 'archive' && method === 'POST') {
        const input = await body(req); assertAllowedKeys(input, ['archived', 'expectedVersion']);
        if (typeof input.archived !== 'boolean') throw new ApiError(400, '归档状态无效');
        result = store.setArchived(id, input.archived, input.expectedVersion as number); mutated = true;
      } else throw new ApiError(405, '请求方法无效');
    } else if (path === '/api/handoffs' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['purpose', 'taskId', 'revisionId', 'sourceIds']);
      result = store.createHandoff(input as Parameters<StoreApi['createHandoff']>[0]); mutated = true;
    } else if (path === '/api/receipts' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, allowedReceipt);
      result = store.submitReceipt(input as unknown as ReceiptInput); mutated = true;
    } else if (path === '/api/assessments' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['taskId', 'revisionId', 'criterionId', 'snapshotId', 'evidenceIds', 'result', 'reason', 'supersedes']);
      result = store.addAssessment(input as unknown as AssessmentInput); mutated = true;
    } else if (path === '/api/acceptances' && method === 'POST') {
      const input = await body(req); assertAllowedKeys(input, ['taskId', 'revisionId', 'snapshotId', 'decision', 'reason']);
      result = store.acceptTask(input as unknown as AcceptInput); mutated = true;
    } else if (path === '/api/backup' && method === 'GET') result = store.createBackup();
    else if (path === '/api/restore' && method === 'POST') {
      const input = await body(req, 256 * 1024 * 1024); assertAllowedKeys(input, ['format', 'version', 'createdAt', 'payload', 'hash']);
      const restoredDirectory = join(dirname(options.dataDirectory), `restored-${Date.now()}-${randomUUID().slice(0, 8)}`);
      const { WorkbenchStore } = await import('./domain/store.ts');
      await mkdir(restoredDirectory, { recursive: true });
      const restored = new WorkbenchStore(join(restoredDirectory, 'workbench.sqlite'));
      try { result = { ...restored.restoreBackup(input as unknown as BackupData), restoredDirectory, restartRequired: true }; }
      finally { restored.close(); }
    } else throw new ApiError(404, '找不到这个接口');
    if (mutated) changed();
    json(res, result);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${req.socket.localPort}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      // 静态入口可从其他应用的链接打开；所有数据接口仍严格校验同源和会话。
      validateLocalHost(req);
      if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) throw new ApiError(405, '请求方法无效');
      const root = resolve(options.webRoot);
      const decoded = decodeURIComponent(url.pathname);
      const candidate = resolve(root, `.${decoded}`);
      if (!isWithin(root, candidate)) throw new ApiError(403, '不允许访问该路径');
      const file = await realpath(candidate).catch(() => extname(candidate) ? null : realpath(join(root, 'index.html')).catch(() => null));
      const resolvedFile = decoded === '/' ? await realpath(join(root, 'index.html')).catch(() => null) : file;
      if (!resolvedFile || !isWithin(root, resolvedFile)) throw new ApiError(404, '网页尚未构建，请运行 npm run build');
      const content = await readFile(resolvedFile);
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': mime[extname(resolvedFile)] ?? 'application/octet-stream', 'Cache-Control': extname(resolvedFile) === '.html' ? 'no-store' : 'private, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const err = error as Error & { status?: number; code?: string };
      const status = err.status ?? (err instanceof TypeError || err instanceof URIError ? 400 : 500);
      json(res, { error: err.code ?? 'ERROR', message: status === 500 ? '本地服务处理失败，请检查终端日志' : err.message }, status);
      if (status === 500) console.error('[workbench]', err.name, err.message);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { for (const client of clients) client.end(); clients.clear(); });
  return server;
}
