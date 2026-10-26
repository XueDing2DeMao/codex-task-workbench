import { useState } from 'react';
import type { Attribution } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage, useQuery } from '../hooks.ts';
import { formatTime, labels, shortId } from '../model.ts';
import { Badge, Dialog, ErrorNotice, Loading } from './Ui.tsx';

const tabs = [{ id: 'text', label: '原始内容' }, { id: 'context', label: '会话记录' }, { id: 'changes', label: '文件变化' }, { id: 'source', label: '来源信息' }] as const;
export function SourceViewer({ recordId, onClose, onChanged }: { recordId: string; onClose: () => void; onChanged: () => void }) {
  const source = useQuery(recordId, signal => api.record(recordId, signal));
  const [tab, setTab] = useState<string>('text'); const [offset, setOffset] = useState(-1);
  const [attribution, setAttribution] = useState<Attribution>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const record = source.data;
  const context = useQuery(`context:${record?.sessionId ?? ''}:${offset}:${tab}`, signal => record && tab === 'context' ? offset < 0 ? api.recordContext(record.id, signal) : api.context(record.sessionId, 30, offset, signal) : Promise.resolve([]));
  return <Dialog title="核对原始记录" description="原文只读；整理任务与作者判定分别保存。" onClose={onClose} wide>
    {source.loading ? <Loading /> : null}<ErrorNotice message={source.error} retry={source.refresh} />
    {record ? <>
      <div className="source-meta"><Badge value={record.attribution} /><Badge value={record.sourceKind} />{record.inherited ? <Badge>继承记录</Badge> : null}{record.archived ? <Badge>已归档来源</Badge> : null}<time>{formatTime(record.timestamp)}</time><span>{record.role}</span></div>
      <div className="tabs" role="tablist" aria-label="原始记录视图">{tabs.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}{item.id === 'changes' && record.changes.length ? <span className="count">{record.changes.length}</span> : null}</button>)}</div>
      {tab === 'text' ? <pre className="source-text">{record.text || '这条记录没有可显示的文本。'}</pre> : null}
      {tab === 'context' ? <><div className="notice notice-info">{offset < 0 ? '展示当前命中及其附近记录；缺失的原始内容不会被补写。' : '正在按会话顺序分页浏览。'}<button className="text-button" onClick={() => setOffset(offset < 0 ? 0 : -1)}>{offset < 0 ? '从会话开头浏览' : '回到命中附近'}</button></div><ErrorNotice message={context.error} retry={context.refresh} />{context.loading ? <Loading /> : <div className="context-list">{context.data?.map(item => <article key={item.id} className={`context-item ${item.id === record.id ? 'is-target' : ''}`}><header><Badge value={item.attribution} /><span>{item.role}</span><time>{formatTime(item.timestamp)}</time>{item.id === record.id ? <strong>当前命中</strong> : null}</header><pre>{item.text || '无文本内容'}</pre></article>)}</div>}{offset >= 0 ? <div className="pagination"><span>会话记录 {offset + 1}–{offset + (context.data?.length ?? 0)}</span><div><button className="button button-small" disabled={offset === 0 || context.loading} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><button className="button button-small" disabled={(context.data?.length ?? 0) < 30 || context.loading} onClick={() => setOffset(offset + 30)}>下一页</button></div></div> : null}</> : null}
      {tab === 'changes' ? record.changes.length ? <div className="changes-list">{record.changes.map((change, index) => <article key={`${change.path}-${index}`}><header><code>{change.path}</code><Badge value={change.status} /></header><pre className="diff-text">{change.diff.split('\n').map((line, lineIndex) => <span key={lineIndex} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line || ' '}{'\n'}</span>)}</pre></article>)}</div> : <div className="notice">这条记录没有解析出的文件变化。文件名被提及不表示文件已经修改。</div> : null}
      {tab === 'source' ? <><dl className="metadata-grid"><dt>会话</dt><dd className="mono">{record.sessionId}</dd><dt>轮次</dt><dd className="mono">{record.turnId || '未提供轮次 ID'}</dd><dt>来源位置</dt><dd><code>{record.filePath}:{record.line}</code></dd><dt>记录标识</dt><dd className="mono">{shortId(record.id)}</dd><dt>内容哈希</dt><dd className="mono">{record.hash}</dd></dl><div className="attribution-form"><label>作者归属<select value={attribution ?? record.attribution} onChange={event => setAttribution(event.target.value as Attribution)}>{(['unknown', 'human', 'agent', 'system'] as const).map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></label><button className="button" disabled={busy || !attribution || attribution === record.attribution} onClick={() => { if (!attribution) return; setBusy(true); setError(''); void api.classify(record.id, attribution).then(() => { source.refresh(); onChanged(); }).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}>{busy ? '正在记录…' : '确认归属'}</button></div><p className="field-hint">这是你对来源的明确确认，不会修改原始日志。</p><details><summary>查看原始 JSON 记录</summary><pre className="source-text raw-text">{record.raw}</pre></details></> : null}
      <ErrorNotice message={error} />
    </> : null}
  </Dialog>;
}
