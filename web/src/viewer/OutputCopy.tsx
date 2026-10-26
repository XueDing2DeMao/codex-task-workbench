import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

export function OutputCopy({ text, number }: { text: string; number: number }) {
  const [state, setState] = useState<CopyState>('idle');
  const request = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    setState('idle'); pending.current = false;
    // 内容更新或离开当前轮次后，旧的复制请求不再更新提示。
    return () => { request.current++; };
  }, [text]);

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = window.setTimeout(() => setState('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    if (pending.current) return;
    pending.current = true;
    const current = ++request.current;
    setState('copying');
    try {
      // 直接复制原文，保留 Markdown、代码缩进和完整链接。
      await navigator.clipboard.writeText(text);
      if (request.current === current) setState('copied');
    } catch {
      if (request.current === current) setState('error');
    } finally {
      if (request.current === current) pending.current = false;
    }
  }

  if (!text.trim()) return null;
  return <div className="output-copy">
    <button type="button" className="output-copy-button" aria-label={`复制第 ${number} 轮全部输出结果`} title="复制完整输出（Markdown）" aria-busy={state === 'copying'} disabled={state === 'copying'} onClick={() => { void copy(); }}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
      <span>{state === 'copied' ? '已复制' : state === 'copying' ? '复制中…' : '复制'}</span>
    </button>
    <span className="sr-only" role="status" aria-live="polite">{state === 'copied' ? `已复制第 ${number} 轮全部输出结果` : ''}</span>
    {state === 'error' ? <span className="output-copy-error" role="alert">复制失败，请重试或选中文字手动复制。</span> : null}
  </div>;
}
