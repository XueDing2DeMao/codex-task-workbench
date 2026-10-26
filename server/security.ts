import { timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, isAbsolute } from 'node:path';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'INVALID_REQUEST') {
    super(message); this.status = status; this.code = code;
  }
}

interface RequestLike { headers: Record<string, string | string[] | undefined>; method?: string; socket: { localPort?: number } }
const header = (req: RequestLike, name: string) => String(req.headers[name] ?? '');
function equalSecret(value: string, secret: string): boolean {
  const a = Buffer.from(value); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateLocalHost(req: RequestLike): void {
  const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  const host = header(req, 'host');
  if (!hosts.includes(host)) throw new ApiError(403, 'Host 不在本地允许范围');
}
export function validateRequest(req: RequestLike, secret: string, bootstrap: boolean): void {
  validateLocalHost(req);
  const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  const origin = header(req, 'origin');
  if (origin && !hosts.some(h => origin === `http://${h}`)) throw new ApiError(403, '请求来源不是本工作台');
  if (header(req, 'sec-fetch-site') === 'cross-site') throw new ApiError(403, '拒绝跨站请求');
  if (!bootstrap) {
    const cookiePrefix = `ctw_session_${req.socket.localPort}=`;
    const session = header(req, 'cookie').split(';').map(v => v.trim()).find(v => v.startsWith(cookiePrefix))?.slice(cookiePrefix.length) ?? '';
    if (!equalSecret(session, secret)) throw new ApiError(403, '本地会话已失效，请刷新页面', 'SESSION_EXPIRED');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
    if (!equalSecret(header(req, 'x-workbench-token'), secret)) throw new ApiError(403, '缺少有效操作令牌');
    if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) throw new ApiError(415, '仅接收 JSON 数据');
  }
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel));
}

export async function validateImportPaths(paths: unknown, allowedRoots: string[]): Promise<string[]> {
  if (!Array.isArray(paths) || !paths.length || paths.length > 20 || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new ApiError(400, '请提供 1 至 20 个历史路径');
  }
  const roots = (await Promise.all(allowedRoots.map(p => realpath(p).catch(() => null)))).filter((p): p is string => !!p);
  const result: string[] = [];
  for (const path of paths) {
    const resolved = await realpath(path).catch(() => { throw new ApiError(400, '历史路径不存在'); });
    if (!roots.some(root => isWithin(root, resolved))) throw new ApiError(403, '历史路径不在允许范围内');
    const info = await stat(resolved);
    if (!info.isDirectory() && (!info.isFile() || extname(resolved).toLowerCase() !== '.jsonl')) throw new ApiError(400, '仅支持历史目录或 .jsonl 文件');
    result.push(resolved);
  }
  return [...new Set(result)];
}

export function assertAllowedKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求必须是 JSON 对象');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ApiError(400, `不允许导入字段：${key}`);
}
