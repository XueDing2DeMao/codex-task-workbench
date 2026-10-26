import { useState } from 'react';
import type { Project, TaskDetail } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage } from '../hooks.ts';
import { emptyContent, readOrganizedDraft } from '../model.ts';
import { Dialog, ErrorNotice, JsonInput } from './Ui.tsx';
import { TaskContentEditor, cleanContent } from './TaskContentEditor.tsx';

export function TaskCreateDialog({ projects, projectId, sourceIds = [], importMode = false, expectedHandoffId, onClose, onCreated }: { projects: Project[]; projectId: string; sourceIds?: string[]; importMode?: boolean; expectedHandoffId?: string; onClose: () => void; onCreated: (detail: TaskDetail) => void }) {
  const [project, setProject] = useState(projectId || projects[0]?.id || '');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => emptyContent(sourceIds));
  const [mode, setMode] = useState(importMode ? 'import' : 'edit'); const [json, setJson] = useState('');
  const [handoffId, setHandoffId] = useState<string>(); const [suggestions, setSuggestions] = useState<string[]>([]); const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Dialog title="新建任务草稿" description="先整理目标和验收标准，核对后再激活为正式版本。" onClose={onClose} wide>
    <div className="segmented dialog-mode"><button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>填写与核对内容</button><button aria-pressed={mode === 'import'} onClick={() => setMode('import')}>导入整理结果</button></div>
    {mode === 'import' ? <><JsonInput value={json} onChange={setJson} label="整理结果 JSON（content、handoffId、suggestions）" /><p className="field-hint">使用检索页生成的整理包。交接包身份必填；没有新增建议时 suggestions 填写 []。</p><div className="dialog-footer"><button className="button button-primary" disabled={!json.trim()} onClick={() => { try { const payload = readOrganizedDraft(json); if (expectedHandoffId && payload.handoffId !== expectedHandoffId) throw new Error('这份结果与当前整理包不匹配。'); setContent(payload.content); setHandoffId(payload.handoffId); setSuggestions(payload.suggestions); setAdopted(new Set()); if (payload.title) setTitle(payload.title); setMode('edit'); setError(''); } catch (problem) { setError(errorMessage(problem)); } }}>读取并核对草稿</button></div></> : <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api.createTask({ projectId: project, title: title.trim(), content: cleanContent({ ...content, requirements: [...content.requirements, ...adopted] }), ...(handoffId ? { handoffId, adoptedSuggestions: [...adopted] } : {}) }).then(onCreated).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false)); }}>
      <div className="form-grid"><label>所属项目<select required value={project} onChange={event => setProject(event.target.value)}><option value="" disabled>选择项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>任务名称<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} placeholder="简洁描述这项工作" /></label></div>
      {sourceIds.length ? <div className="notice notice-info">已关联选中的 {sourceIds.length} 条原始记录。</div> : null}
      {handoffId ? <div className="notice notice-info">整理包 <code>{handoffId}</code> 已关联。创建时将校验包用途、项目和原始来源。</div> : null}
      <TaskContentEditor value={content} onChange={setContent} />
      {suggestions.length ? <fieldset className="suggestions-panel"><legend>新增建议 · 由你决定是否采纳</legend><p>只将你勾选的建议加入要求，并记录明确采纳。</p>{suggestions.map((suggestion, index) => <label className="checkbox-label" key={index}><input type="checkbox" checked={adopted.has(suggestion)} onChange={() => setAdopted(previous => { const next = new Set(previous); if (next.has(suggestion)) next.delete(suggestion); else next.add(suggestion); return next; })} />{suggestion}</label>)}</fieldset> : null}
      <div className="dialog-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy || !project}>{busy ? '正在保存…' : '创建草稿'}</button></div>
    </form>}<ErrorNotice message={error} />
  </Dialog>;
}
