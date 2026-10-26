import { useEffect, useId, useRef, useState } from 'react';
import type { NativeProject, NativeTaskSummary } from '../../../shared/native-contracts.ts';
import { nativeApi } from '../native-api.ts';
import { download } from '../model.ts';
import { errorMessage } from '../hooks.ts';

export function useProjectExport(project: NativeProject, tasks: NativeTaskSummary[]) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [includeRelated, setIncludeRelated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const taskIds = tasks.filter(task => selected.has(task.id)).map(task => task.id);
  const allSelected = tasks.length > 0 && taskIds.length === tasks.length;

  // 项目页卸载时取消请求，避免已切换页面后仍触发旧项目下载。
  useEffect(() => () => { request.current?.abort(); }, []);

  async function exportMarkdown(scope: 'project' | 'tasks') {
    if (request.current || scope === 'tasks' && !taskIds.length) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await nativeApi.exportMarkdown({ projectId: project.id, scope,
        ...(scope === 'tasks' ? { taskIds } : {}), includeRelated }, controller.signal);
      if (controller.signal.aborted) return;
      download(result.filename, result.markdown, 'text/markdown');
      setNotice(`已开始下载 · ${result.taskCount} 个任务`);
    } catch (problem) {
      if (!controller.signal.aborted) setError(errorMessage(problem));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function startSelection() { setSelected(new Set()); setSelecting(true); setNotice(''); setError(''); }
  function cancelSelection() { setSelected(new Set()); setSelecting(false); setNotice(''); setError(''); }
  function toggle(id: string) {
    if (busy) return;
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setNotice(''); setError('');
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(tasks.map(task => task.id)));
    setNotice(''); setError('');
  }
  return { selecting, selected, selectedCount: taskIds.length, allSelected, includeRelated, setIncludeRelated,
    busy, notice, error, exportMarkdown, startSelection, cancelSelection, toggle, toggleAll };
}

type ExportState = ReturnType<typeof useProjectExport>;

export function ProjectExportMenu({ state, archived, taskCount }: { state: ExportState; archived: boolean; taskCount: number }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(state.selecting);
  const menuId = useId();
  useEffect(() => {
    if (wasSelecting.current && !state.selecting) trigger.current?.focus();
    wasSelecting.current = state.selecting;
  }, [state.selecting]);
  useEffect(() => {
    if (!open) return;
    firstAction.current?.focus();
    function closeOutside(event: PointerEvent) { if (!container.current?.contains(event.target as Node)) setOpen(false); }
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [open]);
  return <div className="export-action" ref={container} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} className="export-trigger" aria-expanded={open} aria-controls={menuId} disabled={state.busy} onClick={() => setOpen(value => !value)}>{state.busy ? '正在导出…' : '导出'}</button>
    {open ? <div id={menuId} className="export-menu" role="group" aria-label="导出选项">
      <button ref={firstAction} className="export-menu-item" onClick={() => { setOpen(false); void state.exportMarkdown('project'); }}>{archived ? '导出全部归档任务' : '导出整个项目'}</button>
      <button className="export-menu-item" disabled={!taskCount || state.selecting} onClick={() => { setOpen(false); state.startSelection(); }}>选择任务导出</button>
      <label className="export-related-option"><input type="checkbox" checked={state.includeRelated} onChange={event => state.setIncludeRelated(event.target.checked)} /><span>包含子任务与审查</span></label>
    </div> : null}
  </div>;
}

export function ProjectExportStatus({ state }: { state: ExportState }) {
  const firstSelectionAction = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (state.selecting) firstSelectionAction.current?.focus(); }, [state.selecting]);
  return <>
    {state.error ? <p className="export-feedback is-error" role="alert">{state.error}</p> : null}
    <p className={state.busy || state.notice ? 'export-feedback' : 'sr-only'} role="status" aria-live="polite">{state.busy ? '正在生成 Markdown…' : state.notice}</p>
    {state.selecting ? <div className="selection-toolbar" role="group" aria-label="选择任务导出">
      <span className="selection-count" role="status" aria-live="polite">已选 {state.selectedCount} 项</span>
      <button ref={firstSelectionAction} className="text-button" disabled={state.busy} onClick={state.toggleAll}>{state.allSelected ? '取消全选' : '全选本项目'}</button>
      <div className="selection-actions"><button className="export-submit" disabled={state.busy || !state.selectedCount} onClick={() => { void state.exportMarkdown('tasks'); }}>导出所选</button><button className="text-button" disabled={state.busy} onClick={state.cancelSelection}>取消</button></div>
    </div> : null}
  </>;
}
