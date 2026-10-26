import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { labels } from '../model.ts';

export function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  return <span className={`badge badge-${value ?? 'neutral'}`}>{children ?? (value ? labels[value] ?? value : '')}</span>;
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><span>{message}</span>{retry ? <button className="text-button" onClick={retry}>重试</button> : null}</div>;
}
export function Loading({ label = '正在读取本地数据…' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" />{label}</div>;
}
export function EmptyState({ icon = 'file', title, children, action }: { icon?: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={27} /></div><h3>{title}</h3><p>{children}</p>{action ? <div className="empty-actions">{action}</div> : null}</div>;
}
export function PageHeading({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return <header className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{children ? <p>{children}</p> : null}</div>{actions ? <div className="heading-actions">{actions}</div> : null}</header>;
}
export function Dialog({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><div><h2 id={titleId}>{title}</h2>{description ? <p>{description}</p> : null}</div><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><Icon name="close" /></button></div>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
export function Pagination({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (value: number) => void }) {
  if (!total) return null;
  return <div className="pagination"><span>第 {offset + 1}–{Math.min(offset + limit, total)} 条，共 {total} 条</span><div><button className="button button-small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>上一页</button><button className="button button-small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>下一页</button></div></div>;
}
export function JsonInput({ value, onChange, label = 'JSON 内容' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const inputId = useId();
  const [readError, setReadError] = useState(''); const [reading, setReading] = useState(false);
  return <div className="json-input"><label className="file-input-label">{reading ? '正在读取文件…' : '选择本地 JSON 文件'}<input type="file" disabled={reading} accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) { setReadError(''); setReading(true); void file.text().then(onChange).catch(() => setReadError('无法读取此文件，请重新选择或粘贴 JSON 内容。')).finally(() => setReading(false)); } }} /></label><ErrorNotice message={readError} /><label htmlFor={inputId}>{label}</label><textarea id={inputId} className="code-input" rows={12} value={value} onChange={event => onChange(event.target.value)} spellCheck={false} /></div>;
}
