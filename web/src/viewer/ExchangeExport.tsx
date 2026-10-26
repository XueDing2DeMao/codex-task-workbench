import { useEffect, useRef, useState } from 'react';
import { nativeApi } from '../native-api.ts';
import { download } from '../model.ts';
import { errorMessage } from '../hooks.ts';

export function ExchangeExport({ taskId, exchangeId, number }: { taskId: string; exchangeId: string; number: number }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  // 离开当前轮次时取消请求，不在切换任务后触发旧内容下载。
  useEffect(() => () => { request.current?.abort(); }, []);

  async function exportExchange() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await nativeApi.exportExchange({ taskId, exchangeId }, controller.signal);
      if (controller.signal.aborted) return;
      download(result.filename, result.markdown, 'text/markdown');
      setNotice('已开始下载');
    } catch (problem) {
      if (!controller.signal.aborted) setError(errorMessage(problem));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <>
    <button className="exchange-export-button" aria-label={`导出第 ${number} 轮为 Markdown`} aria-busy={busy} disabled={busy} onClick={() => { void exportExchange(); }}>{busy ? '导出中…' : '导出本轮'}</button>
    <span className={notice ? 'exchange-export-feedback' : 'sr-only'} role="status" aria-live="polite">{busy ? `正在生成第 ${number} 轮 Markdown…` : notice}</span>
    {error ? <p className="exchange-export-feedback is-error" role="alert">{error}</p> : null}
  </>;
}
