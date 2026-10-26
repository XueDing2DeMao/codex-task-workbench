import { useState } from 'react';
import type { AssessmentInput, Revision, TaskDetail } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage } from '../hooks.ts';
import { activeAssessments, criterionState, formatTime, latestReceipt, shortId } from '../model.ts';
import { Badge, Dialog, ErrorNotice } from './Ui.tsx';
import { Icon } from './Icon.tsx';

export function TaskEvidence({ detail, revision, onChanged, onSource }: { detail: TaskDetail; revision: Revision; onChanged: () => void; onSource: (id: string) => void }) {
  const receipts = detail.receipts.filter(receipt => receipt.revisionId === revision.id);
  const snapshots = [...new Set([...receipts.map(receipt => receipt.snapshotId), ...detail.assessments.filter(item => item.revisionId === revision.id).map(item => item.snapshotId)])];
  const latest = latestReceipt(receipts, revision.id);
  const [snapshot, setSnapshot] = useState(latest?.snapshotId ?? snapshots.at(-1) ?? '');
  const [criterionId, setCriterionId] = useState(revision.content.criteria[0]?.id ?? '');
  const [selectedEvidence, setSelectedEvidence] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AssessmentInput['result']>('passed'); const [reason, setReason] = useState(''); const [replacePrevious, setReplacePrevious] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [decision, setDecision] = useState<'accepted' | 'returned' | null>(null); const [decisionReason, setDecisionReason] = useState('');
  const allEvidence = [...new Map(receipts.filter(receipt => receipt.snapshotId === snapshot).flatMap(receipt => receipt.evidence).map(item => [item.id, item])).values()];
  const evidence = allEvidence.filter(item => item.criterionId === criterionId && item.snapshotId === snapshot);
  const invalidPassEvidence = result === 'passed' && (!selectedEvidence.size || evidence.some(item => selectedEvidence.has(item.id) && item.kind === 'agent_report'));
  const assessments = detail.assessments.filter(item => item.revisionId === revision.id && item.snapshotId === snapshot);
  const previous = activeAssessments(assessments, revision.id, snapshot, criterionId);
  const mandatory = revision.content.criteria.filter(item => item.required);
  const stateFor = (id: string) => criterionState(detail.assessments, revision.id, snapshot, id, receipts);
  const passedCount = mandatory.filter(item => stateFor(item.id) === 'passed').length;
  const current = detail.task.currentRevisionId === revision.id;
  const canAccept = current && !detail.task.archived && Boolean(snapshot) && snapshot === latest?.snapshotId && mandatory.length > 0 && passedCount === mandatory.length && !revision.content.conflicts.length && !revision.content.criteria.some(item => ['failed', 'blocked', 'conflict'].includes(stateFor(item.id)));
  const decisions = detail.acceptances.filter(item => item.revisionId === revision.id && item.snapshotId === snapshot);
  function selectCriterion(id: string) { setCriterionId(id); setSelectedEvidence(new Set()); setReason(''); setReplacePrevious(false); }
  return <>
    <div className="section-actions"><div><h3>逐项核对证据</h3><p>判断始终绑定 v{revision.number} 和同一个目标快照，不混用不同运行的对象。</p></div><label className="snapshot-picker">待核对目标快照<select value={snapshot} onChange={event => { setSnapshot(event.target.value); setSelectedEvidence(new Set()); setReplacePrevious(false); }}><option value="">选择快照</option>{snapshots.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
    {!snapshots.length ? <div className="notice notice-info">尚未收到带目标快照的证据。请先在“执行记录”中导入回执。</div> : null}
    {latest ? <div className="notice notice-info">最新执行目标为 <code>{latest.snapshotId}</code>。新的回执到达后，需重新核对证据；失败或中断的执行不能验收通过。</div> : null}
    <ErrorNotice message={error} />
    <div className="evidence-layout"><div className="criteria-status-list">{revision.content.criteria.map(item => <button key={item.id} className={`criterion-status ${item.id === criterionId ? 'is-selected' : ''}`} onClick={() => selectCriterion(item.id)}><div><code>{item.id}</code><small>{item.required ? '必选' : '可选'}</small></div><p>{item.text}</p><Badge value={stateFor(item.id)} /></button>)}</div>
      <div className="evidence-workspace"><h4>{criterionId} · 关联证据</h4>{evidence.length ? <div className="evidence-options">{evidence.map(item => <article className={`evidence-option ${selectedEvidence.has(item.id) ? 'is-selected' : ''}`} key={item.id}><label><input type="checkbox" checked={selectedEvidence.has(item.id)} onChange={() => setSelectedEvidence(previousSelection => { const next = new Set(previousSelection); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} /><span><Badge value={item.kind} /><code>{shortId(item.id)}</code></span></label><pre>{item.text}</pre>{item.sourceId ? <button className="text-button" onClick={() => onSource(item.sourceId!)}>打开原始证据<Icon name="arrow" size={14} /></button> : null}{item.kind === 'agent_report' ? <p className="field-hint">代理自述不能用于通过判断；请取消选择并核对实际结果证据。</p> : null}</article>)}</div> : <p className="empty-inline">当前验收项和快照下没有证据。记录缺口比无依据地标为通过更有用。</p>}
        <form className="assessment-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api.assess({ taskId: detail.task.id, revisionId: revision.id, criterionId, snapshotId: snapshot, evidenceIds: [...selectedEvidence], result, reason: reason.trim(), supersedes: replacePrevious ? previous.map(item => item.id) : undefined }).then(onChanged).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}>
          <h4>记录你的核对结论</h4><p className="field-hint">通过判断须选择实际结果证据；代理自述不能混入通过依据。</p><label>判断<select value={result} onChange={event => setResult(event.target.value as AssessmentInput['result'])}><option value="passed">证据支持通过</option><option value="failed">失败</option><option value="blocked">受阻 / 缺少条件</option></select></label><label>依据与说明<textarea rows={3} required value={reason} onChange={event => setReason(event.target.value)} placeholder="说明你核对了什么，为什么证据支持该结论。" /></label>
          {previous.length ? <label className="checkbox-label"><input type="checkbox" checked={replacePrevious} onChange={event => setReplacePrevious(event.target.checked)} />以此次判断替代本项此前的 {previous.length} 条判断，历史仍保留</label> : null}
          <button className="button button-primary" type="submit" disabled={busy || !snapshot || !criterionId || detail.task.archived || !current || invalidPassEvidence}>{busy ? '记录中…' : '保存人工核对结论'}</button>
        </form>
      </div></div>
    {assessments.length ? <section className="assessment-history"><h3>核对记录</h3>{assessments.map(item => <article key={item.id}><div><code>{item.criterionId}</code><Badge value={item.result} /><span>{formatTime(item.createdAt)}</span><small>人工核对</small></div><p>{item.reason}</p>{item.supersedes?.length ? <small>明确替代 {item.supersedes.length} 条旧判断；旧记录保留。</small> : null}</article>)}</section> : null}
    <section className="acceptance-panel"><div><span className="eyebrow">HUMAN ACCEPTANCE</span><h3>由你确认最终验收</h3><p>当前目标快照中，{passedCount}/{mandatory.length} 项必选标准有通过判断。</p>{!current ? <p className="field-hint">正在查看历史版本，不能改变当前任务的验收状态。</p> : !canAccept ? <p className="field-hint">先为同一快照核对全部必选标准，并解决失败、受阻及冲突，再确认通过。</p> : null}</div><div className="acceptance-actions"><button className="button" disabled={!current || !snapshot || detail.task.archived} onClick={() => { setDecisionReason(''); setDecision('returned'); }}>退回并说明原因</button><button className="button button-primary" disabled={!canAccept} onClick={() => { setDecisionReason(''); setDecision('accepted'); }}><Icon name="check" />验收当前版本</button></div></section>
    {decisions.length ? <div className="acceptance-history">{decisions.map(item => <article key={item.id}><Badge value={item.decision} /><span>v{revision.number} · {formatTime(item.createdAt)} · 人工确认</span><p>{item.reason}</p></article>)}</div> : null}
    {decision ? <Dialog title={decision === 'accepted' ? `确认验收 v${revision.number}` : `退回 v${revision.number}`} description={`本次决定仅针对快照 ${snapshot}；不会验收之后的新版本。`} onClose={() => setDecision(null)}><form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api.accept({ taskId: detail.task.id, revisionId: revision.id, snapshotId: snapshot, decision, reason: decisionReason.trim() }).then(() => { setDecision(null); onChanged(); }).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}><label>{decision === 'accepted' ? '验收说明' : '退回原因'}<textarea rows={4} value={decisionReason} onChange={event => setDecisionReason(event.target.value)} required placeholder={decision === 'accepted' ? '记录你确认的范围与依据。' : '说明需要补充或重新处理的内容。'} /></label><ErrorNotice message={error} /><div className="dialog-footer"><button type="button" className="button" onClick={() => setDecision(null)} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? '正在记录…' : decision === 'accepted' ? '确认验收通过' : '确认退回'}</button></div></form></Dialog> : null}
  </>;
}
