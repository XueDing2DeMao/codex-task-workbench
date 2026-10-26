import { useState } from 'react';
import type { Attribution, Handoff, Project, SearchHit, SearchOptions } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage, useDebounced, useQuery } from '../hooks.ts';
import { formatTime } from '../model.ts';
import { Icon } from '../components/Icon.tsx';
import { Badge, EmptyState, ErrorNotice, Loading, PageHeading, Pagination } from '../components/Ui.tsx';

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = index > 160 ? index - 100 : 0;
  const excerpt = text.slice(start, start + 480);
  const position = index - start;
  return <>{start ? '…' : ''}{position >= 0 && query ? <>{excerpt.slice(0, position)}<mark>{excerpt.slice(position, position + query.length)}</mark>{excerpt.slice(position + query.length)}</> : excerpt}{text.length > start + 480 ? '…' : ''}</>;
}

export function SearchPage({ projectId, projects, refreshKey, onSource, onTask, onCreate, onHandoff, onImport }: {
  projectId: string; projects: Project[]; refreshKey: number; onSource: (id: string) => void; onTask: (id: string, revisionId?: string) => void;
  onCreate: (sourceIds?: string[]) => void; onHandoff: (handoff: Handoff) => void; onImport: () => void;
}) {
  const [q, setQ] = useState(''); const settled = useDebounced(q);
  const [scope, setScope] = useState<SearchOptions['scope']>('instructions'); const [attribution, setAttribution] = useState<Attribution | ''>('');
  const [archived, setArchived] = useState(true); const [offset, setOffset] = useState(0); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const limit = 20;
  const result = useQuery(`search:${projectId}:${settled}:${scope}:${attribution}:${archived}:${offset}:${refreshKey}`, signal => api.search({ q: settled, projectId, scope, attribution: attribution || undefined, archived, limit, offset }, signal));
  const open = (hit: SearchHit) => hit.type === 'source' ? onSource(hit.id) : hit.taskId ? onTask(hit.taskId, hit.revisionId) : undefined;
  const projectName = projects.find(project => project.id === projectId)?.name ?? '全部项目';
  return <>
    <PageHeading eyebrow="SOURCE EXPLORER" title="找回每一次要求" actions={<button className="button" onClick={onImport}><Icon name="upload" />导入历史</button>}>搜索原始指令、旧任务版本和执行结果，始终保留当时的来源。</PageHeading>
    <section className="search-panel" aria-label="检索条件">
      <div className="search-main"><Icon name="search" size={23} /><input aria-label="搜索指令、短句或文件名" type="search" value={q} onChange={event => { setQ(event.target.value); setOffset(0); }} placeholder="输入修改指令、短句或文件名…" /><span className="search-project">{projectName}</span></div>
      <div className="search-filters"><div className="segmented" aria-label="搜索范围">{([{ value: 'instructions', label: '原始指令' }, { value: 'tasks', label: '任务与旧版本' }, { value: 'results', label: '执行结果' }, { value: 'all', label: '全部内容' }] as const).map(item => <button key={item.value} aria-pressed={scope === item.value} onClick={() => { setScope(item.value); setOffset(0); }}>{item.label}</button>)}</div><label className="compact-label">作者<select value={attribution} onChange={event => { setAttribution(event.target.value as Attribution | ''); setOffset(0); }}><option value="">全部来源</option><option value="human">本人确认</option><option value="unknown">待确认</option><option value="agent">代理</option><option value="system">系统</option></select></label><label className="checkbox-label"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setOffset(0); }} />包含归档</label></div>
    </section>
    <ErrorNotice message={result.error} retry={result.refresh} /><ErrorNotice message={error} />
    <div className="section-label"><span>{settled ? `“${settled}”的检索结果` : '可查询的记录'} {result.data ? <strong>{result.data.total}</strong> : null}</span><span>范围：{projectName} · 不限时间</span></div>
    {selected.size ? <div className="selection-bar"><span><strong>{selected.size}</strong> 条来源已选择</span><div><button className="text-button" onClick={() => setSelected(new Set())}>清空</button><button className="button button-small" disabled={busy} onClick={() => { setBusy(true); setError(''); void api.handoff({ purpose: 'organize', sourceIds: [...selected] }).then(onHandoff).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}><Icon name="download" size={16} />{busy ? '生成中…' : '生成整理包'}</button><button className="button button-primary button-small" onClick={() => onCreate([...selected])}><Icon name="plus" size={16} />整理为任务草稿</button></div></div> : null}
    {result.loading ? <Loading label="正在检索本地记录…" /> : result.data?.items.length ? <div className="search-results">{result.data.items.map(hit => <article className="search-hit" key={`${hit.type}:${hit.id}`}>
      {hit.type === 'source' ? <input type="checkbox" className="hit-checkbox" aria-label={`选择来源 ${hit.title || hit.id}`} checked={selected.has(hit.id)} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id); return next; })} /> : <div className="hit-type-icon"><Icon name="tasks" /></div>}
      <button className="hit-content" onClick={() => open(hit)}><div className="hit-meta"><span>{projects.find(project => project.id === hit.projectId)?.name ?? '项目记录'}</span><span className="meta-dot" /><time>{formatTime(hit.timestamp)}</time>{hit.source ? <><Badge value={hit.source.attribution} />{hit.source.sourceKind === 'subagent' ? <Badge value="subagent" /> : null}{hit.source.inherited ? <Badge>继承</Badge> : null}</> : <Badge value={hit.current ? 'passed' : 'neutral'}>{hit.current ? '当前版本' : '历史版本'}</Badge>}</div><h3>{hit.title || (hit.type === 'source' ? '原始记录' : '任务版本')}</h3><p><Highlight text={hit.text} query={settled} /></p><span className="hit-open">{hit.type === 'source' ? '查看原文与执行上下文' : '查看任务版本'}<Icon name="arrow" size={15} /></span></button>
    </article>)}</div> : !result.error ? <EmptyState icon="search" title={settled ? '没有找到匹配的内容' : '这里会保留你提出过的要求'} action={<button className="button button-primary" onClick={onImport}>导入项目历史</button>}>{settled ? '试试更短的词，或切换项目、内容范围与作者筛选。' : '先导入一份 Codex 历史。原始文件保持只读，搜索结果可以进一步整理成任务。'}</EmptyState> : null}
    {result.data ? <Pagination offset={offset} limit={limit} total={result.data.total} onChange={setOffset} /> : null}
  </>;
}
