import { useState } from 'react';
import type { TaskContent, TaskDetail } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { errorMessage } from '../hooks.ts';
import { emptyContent, readOrganizedDraft } from '../model.ts';
import { Dialog, ErrorNotice, JsonInput } from './Ui.tsx';
import { cleanContent, TaskContentEditor } from './TaskContentEditor.tsx';

export function TaskDraftDialog({ detail, importMode = false, onClose, onSaved }: { detail: TaskDetail; importMode?: boolean; onClose: () => void; onSaved: () => void }) {
  const current = detail.revisions.find(item => item.id === detail.task.currentRevisionId);
  const [content, setContent] = useState<TaskContent>(detail.draft?.content ?? current?.content ?? emptyContent());
  const [mode, setMode] = useState(importMode ? 'import' : 'edit'); const [json, setJson] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]); const [adopted, setAdopted] = useState<Set<string>>(new Set()); const [handoffId, setHandoffId] = useState<string>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function readDraft() {
    try {
      const payload = readOrganizedDraft(json);
      setContent(payload.content);
      setSuggestions(payload.suggestions); setAdopted(new Set()); setHandoffId(payload.handoffId); setMode('edit'); setError('');
    } catch (problem) { setError(errorMessage(problem)); }
  }
  return <Dialog title="核对任务修订草稿" description="保存草稿不会改变有效版本；稍后点击“应用为新版本”才正式生效。" onClose={onClose} wide>
    <div className="segmented dialog-mode"><button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑内容</button><button aria-pressed={mode === 'import'} onClick={() => setMode('import')}>导入 Codex 草稿</button></div>
    {mode === 'import' ? <><JsonInput value={json} onChange={setJson} label="草稿 JSON（content、handoffId、suggestions）" /><p className="field-hint">交接包身份必填；没有新增建议时 suggestions 填写 []。</p><div className="dialog-footer"><button className="button button-primary" disabled={!json.trim()} onClick={readDraft}>读取并核对草稿</button></div></> : <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('');
      const finalContent = cleanContent({ ...content, requirements: [...content.requirements, ...adopted] });
      void api.saveDraft(detail.task.id, { content: finalContent, expectedVersion: detail.task.lockVersion, handoffId, adoptedSuggestions: [...adopted] }).then(onSaved).catch(problem => setError(errorMessage(problem))).finally(() => setBusy(false));
    }}>{handoffId ? <div className="notice notice-info">已关联整理包 <code>{handoffId}</code>，保存时将校验版本和来源范围。</div> : null}<TaskContentEditor value={content} onChange={setContent} />
      {suggestions.length ? <fieldset className="suggestions-panel"><legend>新增建议 · 由你决定是否采纳</legend><p>选中的建议会生成你的明确确认记录，原始指令不会被改写。</p>{suggestions.map((suggestion, index) => <label className="checkbox-label" key={index}><input type="checkbox" checked={adopted.has(suggestion)} onChange={() => setAdopted(previous => { const next = new Set(previous); if (next.has(suggestion)) next.delete(suggestion); else next.add(suggestion); return next; })} />{suggestion}</label>)}</fieldset> : null}
      <div className="dialog-footer"><button className="button" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存修订草稿'}</button></div>
    </form>}
    <ErrorNotice message={error} />
  </Dialog>;
}
