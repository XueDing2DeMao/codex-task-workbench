import type { NativeCatalog, NativeExchangeExportRequest, NativeExportRequest, NativeExportResult, NativeSearchResult, NativeTaskDetail } from '../../shared/native-contracts.ts';
import { api, ApiError } from './api.ts';

async function request<T>(path: string, signal?: AbortSignal, input?: NativeExportRequest | NativeExchangeExportRequest): Promise<T> {
  signal?.throwIfAborted();
  const { csrfToken } = await api.bootstrap();
  signal?.throwIfAborted();
  const response = await fetch(`/api/native${path}`, {
    signal, credentials: 'same-origin',
    ...(input ? { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': csrfToken } } : {}),
  });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiError('本地服务返回的内容无法读取，请重新加载。', response.status, 'INVALID_RESPONSE'); }
  if (!response.ok) {
    const problem = data as { message?: string; error?: string } | null;
    throw new ApiError(problem?.message ?? '暂时无法读取本机 Codex 记录。', response.status, problem?.error ?? 'REQUEST_FAILED');
  }
  return data as T;
}

export const nativeApi = {
  catalog: (signal?: AbortSignal, refresh = false) => request<NativeCatalog>(`/catalog${refresh ? '?refresh=1' : ''}`, signal),
  task: (id: string, signal?: AbortSignal) => request<NativeTaskDetail>(`/tasks/${encodeURIComponent(id)}`, signal),
  search: (q: string, signal?: AbortSignal) => request<NativeSearchResult>(`/search?${new URLSearchParams({ q })}`, signal),
  exportMarkdown: (input: NativeExportRequest, signal?: AbortSignal) => request<NativeExportResult>('/export/markdown', signal, input),
  exportExchange: (input: NativeExchangeExportRequest, signal?: AbortSignal) => request<NativeExportResult>('/export/exchange', signal, input),
};
