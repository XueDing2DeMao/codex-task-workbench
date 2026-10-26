import type { TaskContent } from '../../../shared/contracts.ts';
import { Icon } from './Icon.tsx';

export function TaskContentEditor({ value, onChange }: { value: TaskContent; onChange: (value: TaskContent) => void }) {
  const update = <K extends keyof TaskContent>(key: K, next: TaskContent[K]) => onChange({ ...value, [key]: next });
  return <div className="content-editor">
    <label>任务目标<textarea rows={2} value={value.goal} required onChange={event => update('goal', event.target.value)} placeholder="这项工作完成后，应带来什么明确结果？" /></label>
    <label>当前有效要求<span className="field-hint">每行一条，保留可核对的具体要求。</span><textarea rows={4} value={value.requirements.join('\n')} onChange={event => update('requirements', event.target.value.split('\n'))} placeholder={'例如：默认仅搜索当前项目\n允许切换到全部项目'} /></label>
    <div className="form-grid"><label>实施范围<textarea rows={3} value={value.scope} onChange={event => update('scope', event.target.value)} placeholder="涉及的页面、数据或行为" /></label><label>不做事项<textarea rows={3} value={value.nonGoals} onChange={event => update('nonGoals', event.target.value)} placeholder="本次明确排除的内容" /></label></div>
    <fieldset className="criteria-editor"><legend>验收标准</legend><p className="field-hint">写清条件、操作和预期结果。执行结束后，按这些标准核对证据。</p>
      {value.criteria.map((criterion, index) => <div className="criterion-edit" key={criterion.id}>
        <div className="criterion-edit-meta"><span className="mono">{criterion.id}</span><label className="checkbox-label"><input type="checkbox" checked={criterion.required} onChange={event => update('criteria', value.criteria.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />必选</label></div>
        <textarea aria-label={`${criterion.id} 验收内容`} rows={2} value={criterion.text} required onChange={event => update('criteria', value.criteria.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} placeholder="在什么条件下，做什么操作，应出现什么结果？" />
        <button type="button" className="icon-button" aria-label={`删除 ${criterion.id}`} disabled={value.criteria.length <= 1} onClick={() => update('criteria', value.criteria.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" size={16} /></button>
      </div>)}
      <button type="button" className="text-button" onClick={() => {
        let index = value.criteria.length + 1;
        while (value.criteria.some(item => item.id === `AC-${String(index).padStart(2, '0')}`)) index++;
        update('criteria', [...value.criteria, { id: `AC-${String(index).padStart(2, '0')}`, text: '', required: true }]);
      }}><Icon name="plus" size={16} />添加验收标准</button>
    </fieldset>
    <details className="advanced-fields"><summary>来源关联与待解决问题 <span>{value.sourceIds.filter(Boolean).length} 条来源</span></summary><label>关联的来源记录 ID<span className="field-hint">从检索结果选择的来源会自动保留。仅填写工作台中已有的记录。</span><textarea rows={2} className="code-input" value={value.sourceIds.join('\n')} onChange={event => update('sourceIds', event.target.value.split('\n'))} /></label><label>未解决问题<span className="field-hint">每行一项；存在未解决问题时，草稿不能成为有效版本。</span><textarea rows={2} value={value.conflicts.join('\n')} onChange={event => update('conflicts', event.target.value.split('\n'))} /></label></details>
  </div>;
}

export function cleanContent(content: TaskContent): TaskContent {
  return { ...content, goal: content.goal.trim(), requirements: content.requirements.map(item => item.trim()).filter(Boolean), criteria: content.criteria.map(item => ({ ...item, text: item.text.trim() })), sourceIds: [...new Set(content.sourceIds.map(item => item.trim()).filter(Boolean))], conflicts: content.conflicts.map(item => item.trim()).filter(Boolean) };
}
