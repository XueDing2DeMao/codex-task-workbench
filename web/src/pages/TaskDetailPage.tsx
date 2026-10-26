import { useState } from 'react';
import type { Handoff } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage, useQuery } from '../hooks.ts';
import { download, formatTime, safeFilename, shortId } from '../model.ts';
import { Badge, Dialog, ErrorNotice, Loading, PageHeading } from '../components/Ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { TaskDraftDialog } from '../components/TaskDraftDialog.tsx';
import { RevisionHistory, TaskRequirements } from '../components/TaskRequirements.tsx';
import { TaskExecutions } from '../components/TaskExecutions.tsx';
import { TaskEvidence } from '../components/TaskEvidence.tsx';

export function TaskDetailPage({ taskId, initialRevisionId, onBack, onChanged, onSource, onHandoff }: { taskId: string; initialRevisionId?: string; onBack: () => void; onChanged: () => void; onSource: (id: string) => void; onHandoff: (handoff: Handoff) => void }) {
  const query = useQuery(taskId, signal => api.task(taskId, signal));
  const [selectedId, setSelectedId] = useState(initialRevisionId ?? ''); const [tab, setTab] = useState('requirements');
  const [draftMode, setDraftMode] = useState<'edit' | 'import' | null>(null); const [confirmActivate, setConfirmActivate] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const detail = query.data;
  const revision = detail?.revisions.find(item => item.id === (selectedId || detail.task.currentRevisionId));
  const current = revision?.id === detail?.task.currentRevisionId;
  const historical = Boolean(revision && !current);
  function changed() { query.refresh(); onChanged(); }
  function exportFile(format: 'json' | 'markdown') {
    if (!detail) return;
    setBusy(true); setError(''); void api.exportTask(taskId).then(result => download(`${safeFilename(detail.task.title)}.${format === 'json' ? 'json' : 'md'}`, format === 'json' ? JSON.stringify(result.json, null, 2) : result.markdown, format === 'json' ? 'application/json' : 'text/markdown')).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false));
  }
  if (query.loading) return <Loading label="正在读取任务与版本记录…" />;
  if (!detail) return <><button className="text-button" onClick={onBack}><Icon name="back" />返回任务列表</button><ErrorNotice message={query.error || '未找到任务。'} retry={query.refresh} /></>;
  return <>
    <button className="text-button back-link" onClick={onBack}><Icon name="back" size={16} />返回任务列表</button>
    <PageHeading eyebrow={`TASK / ${shortId(detail.task.id)}`} title={detail.task.title} actions={<><button className="button" disabled={busy} onClick={() => exportFile('markdown')}><Icon name="download" />导出 Markdown</button><button className="button" disabled={busy} onClick={() => exportFile('json')}>JSON</button><button className="button" disabled={busy || historical} onClick={() => { setBusy(true); setError(''); void api.archive(taskId, !detail.task.archived, detail.task.lockVersion).then(changed).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}><Icon name="archive" />{detail.task.archived ? '恢复任务' : '归档'}</button></>}>更新于 {formatTime(detail.task.updatedAt)}{detail.task.archived ? ' · 已归档，恢复后可继续编辑' : ''}</PageHeading>
    <ErrorNotice message={query.error} retry={query.refresh} /><ErrorNotice message={error} />
    <div className="task-version-bar"><div>{revision ? <><span className="version-pill">v{revision.number}</span><Badge value={current ? 'passed' : 'neutral'}>{current ? '当前有效版本' : '历史版本 · 只读'}</Badge></> : <Badge>尚未激活 · 初始草稿</Badge>}<span className="muted">{detail.revisions.length} 个正式版本</span></div><div><label className="compact-label">查看版本<select aria-label="查看任务版本" value={revision?.id ?? ''} onChange={event => setSelectedId(event.target.value)} disabled={!detail.revisions.length}>{!detail.revisions.length ? <option value="">暂无正式版本</option> : null}{[...detail.revisions].sort((a, b) => b.number - a.number).map(item => <option value={item.id} key={item.id}>v{item.number}{item.id === detail.task.currentRevisionId ? ' · 当前' : ''}</option>)}</select></label><button className="button button-small" disabled={busy || detail.task.archived || historical} onClick={() => { setBusy(true); setError(''); void api.handoff({ purpose: 'organize', taskId }).then(result => { onHandoff(result); changed(); }).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}><Icon name="download" size={16} />生成整理包</button><button className="button button-small" disabled={detail.task.archived || historical} onClick={() => setDraftMode('import')}><Icon name="upload" size={16} />导入草稿</button><button className="button button-primary button-small" disabled={detail.task.archived || historical} onClick={() => setDraftMode('edit')}><Icon name="plus" size={16} />{detail.draft ? '编辑草稿' : '修订任务'}</button></div></div>
    {detail.draft ? <section className="draft-banner"><div><Icon name="file" size={22} /><div><strong>{detail.task.currentRevisionId ? '有一份尚未生效的修订草稿' : '先核对草稿，再开始执行'}</strong><p>{detail.draft.content.conflicts.length ? `${detail.draft.content.conflicts.length} 个问题仍待解决，处理后才能激活。` : '应用后会创建新版本，保留此前要求、回执与验收。'}</p></div></div><div><button className="button button-small" onClick={() => setDraftMode('edit')} disabled={detail.task.archived || historical}>核对草稿</button><button className="button button-primary button-small" disabled={detail.task.archived || historical || detail.draft.content.conflicts.length > 0} onClick={() => setConfirmActivate(true)}>应用为{detail.task.currentRevisionId ? '新版本' : ' v1'}</button></div></section> : null}
    <section className="panel task-detail-panel"><div className="tabs" role="tablist" aria-label="任务详情">{[{ id: 'requirements', label: '版本要求' }, { id: 'revisions', label: '指令与修订' }, { id: 'executions', label: '执行记录' }, { id: 'evidence', label: '验收证据' }].map(item => <button role="tab" aria-selected={tab === item.id} key={item.id} disabled={!revision && item.id !== 'requirements'} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="task-tab-content">
      {tab === 'requirements' && (revision || detail.draft) ? <>{!revision ? <div className="notice notice-info">下方是草稿预览，尚未成为可执行的正式版本。</div> : null}<TaskRequirements content={revision?.content ?? detail.draft!.content} onSource={onSource} /></> : null}
      {tab === 'revisions' && revision ? <><RevisionHistory revisions={detail.revisions} currentId={detail.task.currentRevisionId} selectedId={revision.id} onSelect={setSelectedId} /><details className="audit-log"><summary>操作记录 · {detail.audit.length} 条</summary>{detail.audit.map(item => <article key={item.id}><time>{formatTime(item.createdAt)}</time><strong>{item.action}</strong><p>{item.detail}</p></article>)}</details></> : null}
      {tab === 'executions' && revision ? <TaskExecutions key={revision.id} detail={detail} revision={revision} onChanged={changed} onHandoff={onHandoff} onSource={onSource} /> : null}
      {tab === 'evidence' && revision ? <TaskEvidence key={revision.id} detail={detail} revision={revision} onChanged={changed} onSource={onSource} /> : null}
    </div></section>
    {draftMode ? <TaskDraftDialog detail={detail} importMode={draftMode === 'import'} onClose={() => setDraftMode(null)} onSaved={() => { setDraftMode(null); changed(); }} /> : null}
    {confirmActivate ? <Dialog title="将草稿应用为有效版本" description="这是任务要求的明确变更。旧版本记录会保留，新版本从未验证、未验收开始。" onClose={() => setConfirmActivate(false)}><p>请确认已核对“{detail.task.title}”的目标、要求与验收标准。</p><ErrorNotice message={error} /><div className="dialog-footer"><button className="button" onClick={() => setConfirmActivate(false)} disabled={busy}>继续核对</button><button className="button button-primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void api.activate(taskId, detail.task.lockVersion).then(result => { setConfirmActivate(false); setSelectedId(result.task.currentRevisionId ?? ''); changed(); }).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}>{busy ? '正在应用…' : '确认应用新版本'}</button></div></Dialog> : null}
  </>;
}
