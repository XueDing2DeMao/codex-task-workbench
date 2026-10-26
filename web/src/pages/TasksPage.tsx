import { useState } from 'react';
import { api } from '../api.ts';
import { useDebounced, useQuery } from '../hooks.ts';
import { formatTime, shortId } from '../model.ts';
import { Icon } from '../components/Icon.tsx';
import { Badge, EmptyState, ErrorNotice, Loading, PageHeading, Pagination } from '../components/Ui.tsx';

export function TasksPage({ projectId, refreshKey, onTask, onCreate }: { projectId: string; refreshKey: number; onTask: (id: string) => void; onCreate: () => void }) {
  const [q, setQ] = useState(''); const settled = useDebounced(q); const [archived, setArchived] = useState(false); const [offset, setOffset] = useState(0);
  const tasks = useQuery(`tasks:${projectId}:${settled}:${archived}:${refreshKey}`, signal => api.tasks({ projectId, q: settled, archived }, signal));
  const limit = 20; const items = tasks.data?.slice(offset, offset + limit) ?? [];
  return <>
    <PageHeading eyebrow="TASK LIBRARY" title="任务与验收" actions={<button className="button button-primary" onClick={onCreate}><Icon name="plus" />新建任务</button>}>让每项工作都有明确要求、可追溯版本和验收依据。</PageHeading>
    <div className="table-toolbar"><label className="inline-search"><Icon name="search" /><input type="search" aria-label="筛选任务" placeholder="按名称或任务编号筛选" value={q} onChange={event => { setQ(event.target.value); setOffset(0); }} /></label><label className="checkbox-label"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setOffset(0); }} />包含已归档任务</label></div>
    <ErrorNotice message={tasks.error} retry={tasks.refresh} />
    {tasks.loading ? <Loading /> : items.length ? <div className="table-shell"><table className="task-table"><thead><tr><th>任务</th><th>有效版本</th><th>证据核对</th><th>人工验收</th><th>最近更新</th><th><span className="sr-only">打开</span></th></tr></thead><tbody>{items.map(task => <tr key={task.id}><td><button className="task-title-button" onClick={() => onTask(task.id)}><span>{task.title}</span><small>{shortId(task.id)}{task.archived ? ' · 已归档' : ''}</small></button></td><td><div className="version-stack"><span className="version-pill">{task.currentRevisionId ? `v${task.revisionNumber}` : '尚未激活'}</span>{task.hasDraft ? <small className="draft-label">有待核对草稿</small> : null}</div></td><td><Badge value={task.verification} /></td><td><Badge value={task.acceptance} /></td><td className="muted nowrap">{formatTime(task.updatedAt)}</td><td><button className="icon-button" aria-label={`打开 ${task.title}`} onClick={() => onTask(task.id)}><Icon name="chevron" /></button></td></tr>)}</tbody></table></div> : !tasks.error ? <EmptyState icon="tasks" title={settled ? '没有匹配的任务' : '从一张清楚的任务卡开始'} action={<button className="button button-primary" onClick={onCreate}><Icon name="plus" />新建任务草稿</button>}>{settled ? '调整名称筛选，或包含归档任务再试一次。' : '手工填写目标和验收标准，或从检索结果选择原始指令来整理。'}</EmptyState> : null}
    {tasks.data ? <Pagination offset={offset} limit={limit} total={tasks.data.length} onChange={setOffset} /> : null}
  </>;
}
