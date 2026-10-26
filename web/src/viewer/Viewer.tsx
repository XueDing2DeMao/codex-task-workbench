import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { NativeExchange, NativeProject, NativeTaskSummary } from '../../../shared/native-contracts.ts';
import { Icon } from '../components/Icon.tsx';
import { useDebounced, useQuery } from '../hooks.ts';
import { nativeApi } from '../native-api.ts';
import { Content } from './Content.tsx';
import { ExchangeExport } from './ExchangeExport.tsx';
import { OutputCopy } from './OutputCopy.tsx';
import { LoadingSkeleton as Loading } from './LoadingSkeleton.tsx';
import { ProjectExportMenu, ProjectExportStatus, useProjectExport } from './ProjectExport.tsx';
import { buildTaskHierarchy, groupSearchResults } from './task-groups.ts';
import type { GroupedTaskSummary, TaskHierarchy } from './task-groups.ts';

interface Route { project?: string; task?: string; q?: string; turn?: string; child?: string }
type Navigate = (route: Route, replace?: boolean) => void;
const PAGE_SIZE = 36;
const ARCHIVE_PROJECT_ID = 'native:archived';
function readRoute(): Route {
  const query = new URLSearchParams(window.location.search);
  return { project: query.get('project') || undefined, task: query.get('task') || undefined, q: query.get('q') || undefined, turn: query.get('turn') || undefined, child: query.get('child') || undefined };
}
function hrefFor(route: Route) {
  const query = new URLSearchParams();
  if (route.project) query.set('project', route.project);
  if (route.task) query.set('task', route.task);
  if (route.child) query.set('child', route.child);
  if (route.turn) query.set('turn', route.turn);
  if (route.q) query.set('q', route.q);
  return query.size ? `/?${query}` : '/';
}
function NavLink({ route, navigate, className, children, label }: { route: Route; navigate: Navigate; className?: string; children: ReactNode; label?: string }) {
  function click(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); navigate(route);
  }
  return <a href={hrefFor(route)} onClick={click} className={className} aria-label={label}>{children}</a>;
}
function Brand() {
  return <><svg width="32" height="36" viewBox="0 0 32 36" aria-hidden="true"><path fill="currentColor" d="M16 1 31 9.5v17L16 35 1 26.5v-17Z" /><path fill="#fff" fillOpacity=".9" d="m16 10 7 4v8l-7 4-7-4v-8Z" /><path fill="#fff" fillOpacity=".25" d="m16 1 15 8.5-8 4.5-7-4Z" /></svg><span className="brand-name">任务空间</span></>;
}
function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><Icon name="search" size={32} /><h2>{title}</h2><p>{children}</p>{action}</div>;
}
function Heading({ title, count, description, action }: { title: string; count?: string; description?: string; action?: ReactNode }) {
  return <header className="page-heading"><div className="heading-row"><div className="heading-title"><h1 id="page-title" tabIndex={-1}>{title}</h1>{count ? <span className="item-count">{count}</span> : null}</div>{action}</div>{description ? <p className="page-description">{description}</p> : null}</header>;
}
function ArchiveLink({ project, navigate }: { project: NativeProject; navigate: Navigate }) {
  return <NavLink route={{ project: project.id }} navigate={navigate} className="archive-entry" label={`查看已归档任务（${project.taskCount} 个）`}><Icon name="archive" size={18} /><span>已归档</span><span className="archive-entry-count">{project.taskCount}</span></NavLink>;
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-state" role="alert"><Icon name="file" size={32} /><h2>暂时无法读取内容</h2><p>{message}</p><button className="text-button" onClick={retry}>重新加载</button></div>;
}
function TaskMarks({ task }: { task: NativeTaskSummary }) {
  return <span className="task-marks">{task.source === 'subagent' ? <span>子任务</span> : task.source === 'guardian' ? <span>审查任务</span> : null}{task.archived ? <span>已归档</span> : null}{task.availability === 'unavailable' ? <span>正文暂不可用</span> : null}</span>;
}
function ProjectCard({ project, navigate }: { project: NativeProject; navigate: Navigate }) {
  return <NavLink route={{ project: project.id }} navigate={navigate} className="viewer-card project-card" label={`查看项目：${project.name}`}>
    <h2 className="card-title">{project.name}</h2>
    <span className="project-task-count">{project.taskCount} 个任务</span>
  </NavLink>;
}
function TaskCard({ task, navigate }: { task: GroupedTaskSummary; navigate: Navigate }) {
  return <NavLink route={{ project: task.projectId, task: task.id, turn: task.matchTurnId, child: task.matchChildId }} navigate={navigate} className="viewer-card task-card" label={`查看任务：${task.title}`}>
    <h2 className="card-title">{task.title}</h2>
    <span className="task-counts">{task.turnCount} 轮需求 · {task.outputCount} 项输出</span>
  </NavLink>;
}
function TaskGrid({ tasks, navigate, selection }: { tasks: GroupedTaskSummary[]; navigate: Navigate; selection?: { selected: Set<string>; busy: boolean; toggle: (id: string) => void } }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  return <><div className="card-grid task-grid">{tasks.slice(0, visible).map(task => selection ? <div className={`selectable-task${selection.selected.has(task.id) ? ' is-selected' : ''}`} key={task.id}>
    <label className="task-select"><input type="checkbox" aria-label={`选择任务：${task.title}`} checked={selection.selected.has(task.id)} disabled={selection.busy} onChange={() => selection.toggle(task.id)} /></label>
    <TaskCard task={task} navigate={navigate} />
  </div> : <TaskCard key={task.id} task={task} navigate={navigate} />)}</div>{visible < tasks.length ? <div className="load-more"><button className="text-button" onClick={() => setVisible(value => value + PAGE_SIZE)}>显示更多任务（还有 {tasks.length - visible} 个）</button><small>已显示 {Math.min(visible, tasks.length)} / {tasks.length} 个任务</small></div> : null}</>;
}
function ProjectTasks({ project, tasks, navigate }: { project: NativeProject; tasks: GroupedTaskSummary[]; navigate: Navigate }) {
  const state = useProjectExport(project, tasks);
  return <><Breadcrumbs project={project} navigate={navigate} /><Heading title={project.name} count={`${tasks.length} 个任务`} action={<ProjectExportMenu state={state} archived={project.id === ARCHIVE_PROJECT_ID} taskCount={tasks.length} />} />
    <ProjectExportStatus state={state} />
    {tasks.length ? <TaskGrid tasks={tasks} navigate={navigate} selection={state.selecting ? state : undefined} /> : <Empty title={project.id === ARCHIVE_PROJECT_ID ? '暂无未关联项目的任务' : '这个项目还没有你发起的任务'}>之后的相关任务会展示在这里。</Empty>}
  </>;
}
function Breadcrumbs({ project, task, navigate }: { project?: NativeProject; task?: NativeTaskSummary; navigate: Navigate }) {
  return <nav className="breadcrumbs" aria-label="当前位置"><NavLink route={{}} navigate={navigate}>所有项目</NavLink>{project ? <><Icon name="chevron" size={13} />{task ? <NavLink route={{ project: project.id }} navigate={navigate}>{project.name}</NavLink> : <span aria-current="page">{project.name}</span>}</> : null}{task ? <><Icon name="chevron" size={13} /><span aria-current="page">{task.title}</span></> : null}</nav>;
}
function Exchange({ taskId, exchange, number, highlighted = false }: { taskId: string; exchange: NativeExchange; number: number; highlighted?: boolean }) {
  return <section id={`exchange-${taskId}-${exchange.id}`} className={`exchange${highlighted ? ' is-search-match' : ''}`} tabIndex={highlighted ? -1 : undefined} aria-label={`${highlighted ? '搜索命中，' : ''}第 ${number} 轮需求与输出`}>
    <div className="exchange-heading"><span>第 {number} 轮{highlighted ? <small className="match-label">搜索命中</small> : null}</span><div className="exchange-actions">{exchange.createdAt ? <time dateTime={exchange.createdAt}>{formatTime(exchange.createdAt)}</time> : null}<ExchangeExport key={`${taskId}:${exchange.id}`} taskId={taskId} exchangeId={exchange.id} number={number} /></div></div>
    <div className="detail-grid">
      <section className="detail-panel" aria-label={`第 ${number} 轮需求`}><div className="panel-heading"><h2>需求</h2></div><div className="requirement-list">{exchange.requirements.length ? exchange.requirements.map((text, index) => <div className="requirement-item" key={index}><Content text={text} /></div>) : <p className="muted">本轮没有独立的需求文本。</p>}</div></section>
      <section className="detail-panel" aria-label={`第 ${number} 轮输出结果`}><div className="panel-heading output-heading"><div className="output-heading-title"><h2>输出结果</h2>{exchange.outputs.length > 1 ? <small>{exchange.outputs.length} 项结果</small> : null}</div><OutputCopy key={`${taskId}:${exchange.id}`} text={exchange.outputs.map(output => output.text).join('\n\n')} number={number} /></div><div className="output-list">{exchange.outputs.length ? exchange.outputs.map(output => <article className="output-item" key={output.id}><Content text={output.text} /></article>) : <div className="output-empty"><Icon name="file" size={28} /><p>暂无对应输出</p><small>本轮记录中还没有最终输出内容。</small></div>}</div></section>
    </div>
  </section>;
}
function TaskConversation({ task, revision, highlightTurn }: { task: NativeTaskSummary; revision: number; highlightTurn?: string }) {
  const detail = useQuery(`native-task:${task.id}:${revision}`, signal => nativeApi.task(task.id, signal));
  const [visible, setVisible] = useState(12);
  const lastScrolled = useRef('');
  const exchanges = detail.data?.exchanges ?? [];
  useEffect(() => {
    if (!highlightTurn) { lastScrolled.current = ''; return; }
    if (!detail.data || detail.loading || lastScrolled.current === highlightTurn) return;
    const index = detail.data.exchanges.findIndex(exchange => exchange.id === highlightTurn);
    if (index < 0) return;
    if (visible <= index) { setVisible(index + 1); return; }
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`exchange-${task.id}-${highlightTurn}`);
      if (element) { element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'start' }); lastScrolled.current = highlightTurn; }
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightTurn, detail.data, detail.loading, visible, task.id]);
  return <>
    {detail.loading ? <Loading label="正在读取完整需求与输出…" variant="conversation" /> : null}
    {detail.error ? <Failure message={detail.error} retry={detail.refresh} /> : null}
    {detail.data && !detail.loading && !detail.error ? detail.data.availability === 'unavailable' ? <Empty title="正文暂时无法读取">任务目录已找到，但对应历史正文当前不可用。</Empty> : exchanges.length ? <>
      <div className="exchanges">{exchanges.slice(0, visible).map((exchange, index) => <Exchange key={exchange.id} taskId={task.id} exchange={exchange} number={index + 1} highlighted={exchange.id === highlightTurn} />)}</div>
      {visible < exchanges.length ? <div className="load-more"><button className="text-button" onClick={() => setVisible(value => value + 12)}>显示后续需求与输出（还有 {exchanges.length - visible} 轮）</button><small>已显示 {Math.min(visible, exchanges.length)} / {exchanges.length} 轮</small></div> : null}
    </> : <Empty title="这个任务还没有需求与输出">任务已保留在项目中，当前没有可展示的对话内容。</Empty> : null}
  </>;
}
function ChildTaskRow({ task, revision, selected, highlightTurn }: { task: NativeTaskSummary; revision: number; selected: boolean; highlightTurn?: string }) {
  const [open, setOpen] = useState(selected);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    if (!highlightTurn) {
      const frame = requestAnimationFrame(() => { summary.current?.focus({ preventScroll: true }); summary.current?.scrollIntoView({ block: 'start' }); });
      return () => cancelAnimationFrame(frame);
    }
  }, [selected, highlightTurn]);
  return <details className={`child-task${selected ? ' is-selected-child' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary ref={summary} className="child-task-toggle" aria-expanded={open} aria-controls={`child-content-${task.id}`}>
      <Icon name="chevron" size={16} /><span className="child-task-name">{task.title}<small>{task.turnCount} 轮需求 · {task.outputCount} 项输出</small></span><TaskMarks task={task} />
    </summary>
    <div id={`child-content-${task.id}`} hidden={!open} className="child-task-content">{open ? <TaskConversation task={task} revision={revision} highlightTurn={selected ? highlightTurn : undefined} /> : null}</div>
  </details>;
}
function RelatedTasks({ tasks, revision, selectedChild, highlightTurn }: { tasks: NativeTaskSummary[]; revision: number; selectedChild?: string; highlightTurn?: string }) {
  const [open, setOpen] = useState(Boolean(selectedChild));
  useEffect(() => { if (selectedChild) setOpen(true); }, [selectedChild]);
  if (!tasks.length) return null;
  return <details className="related-tasks" open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary className="related-tasks-toggle" aria-expanded={open} aria-controls="related-task-list"><Icon name="chevron" size={17} /><span>子任务与审查</span><span className="related-task-count">{tasks.length}</span><small>归属于当前主任务</small></summary>
    <div id="related-task-list" hidden={!open} className="related-task-list">{open ? tasks.map(task => <ChildTaskRow key={task.id} task={task} revision={revision} selected={task.id === selectedChild} highlightTurn={highlightTurn} />) : null}</div>
  </details>;
}
function TaskDetails({ task, project, children, navigate, revision, highlightTurn, selectedChild }: { task: NativeTaskSummary; project?: NativeProject; children: NativeTaskSummary[]; navigate: Navigate; revision: number; highlightTurn?: string; selectedChild?: string }) {
  return <><Breadcrumbs project={project} task={task} navigate={navigate} /><Heading title={task.title} description={`${project?.name ?? '未归类任务'} · ${task.turnCount} 轮需求与对应输出`} /><div className="detail-marks"><TaskMarks task={task} /></div>
    <RelatedTasks tasks={children} revision={revision} selectedChild={selectedChild} highlightTurn={highlightTurn} />
    <TaskConversation task={task} revision={revision} highlightTurn={selectedChild ? undefined : highlightTurn} />
  </>;
}
function SearchResults({ hierarchy, query, navigate, revision }: { hierarchy: TaskHierarchy; query: string; navigate: Navigate; revision: number }) {
  const result = useQuery(`native-search:${query}:${revision}`, signal => nativeApi.search(query, signal));
  const data = useMemo(() => result.data ? groupSearchResults(result.data, hierarchy) : undefined, [result.data, hierarchy]);
  const projectMatches = data?.projects.filter(project => project.id !== ARCHIVE_PROJECT_ID) ?? [];
  const archiveMatch = data?.projects.find(project => project.id === ARCHIVE_PROJECT_ID);
  return <><Heading title="搜索结果" count={data && !result.loading ? `${data.total} 项匹配` : undefined} description={`在全部项目、任务、需求与输出中搜索“${query}”`} />
    {result.loading ? <Loading label="正在检索全部正文…" /> : null}
    {result.error ? <Failure message={result.error} retry={result.refresh} /> : null}
    {data && !result.loading && !result.error ? <>
      {!data.total ? <Empty title="没有找到相关内容" action={<button className="text-button" onClick={() => navigate({})}>返回所有项目</button>}>试试更短的关键词，或用空格组合多个词。</Empty> : null}
      {projectMatches.length ? <section className="search-section" aria-labelledby="project-results"><div className="section-heading"><h2 id="project-results">项目</h2><span>{projectMatches.length} 个项目</span></div><div className="card-grid project-grid">{projectMatches.map(project => <ProjectCard key={project.id} project={project} navigate={navigate} />)}</div></section> : null}
      {archiveMatch ? <div className="search-archive-entry"><ArchiveLink project={archiveMatch} navigate={navigate} /></div> : null}
      {data.tasks.length ? <section className="search-section" aria-labelledby="task-results"><div className="section-heading"><h2 id="task-results">任务</h2><span>{data.tasks.length} 个任务</span></div><TaskGrid key={query} tasks={data.tasks} navigate={navigate} /></section> : null}
      <p className="sr-only" role="status">找到 {data.total} 项匹配结果</p>
    </> : null}
  </>;
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export default function Viewer() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [revision, setRevision] = useState(0);
  const query = useDebounced(route.q?.trim() ?? '', 180);
  const workspace = useQuery(`native-catalog:${revision}`, signal => nativeApi.catalog(signal, revision > 0));
  const catalog = workspace.data;
  const savedProjects = catalog?.projects.filter(item => item.id !== ARCHIVE_PROJECT_ID) ?? [];
  const projectCount = savedProjects.length;
  const archive = catalog?.projects.find(item => item.id === ARCHIVE_PROJECT_ID);
  const hierarchy = useMemo(() => buildTaskHierarchy(catalog?.tasks ?? []), [catalog]);
  const task = route.task ? hierarchy.rootByTaskId.get(route.task) : undefined;
  const childId = task && route.task !== task.id ? route.task : route.child;
  const selectedChild = childId && childId !== task?.id && hierarchy.rootByTaskId.get(childId)?.id === task?.id ? childId : undefined;
  const project = catalog?.projects.find(item => item.id === (task?.projectId ?? route.project));
  const projectTasks = useMemo(() => hierarchy.tasks.filter(item => item.projectId === project?.id), [hierarchy, project?.id]);
  useEffect(() => { function pop() { setRoute(readRoute()); } window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => { document.title = `${task?.title ?? project?.name ?? (route.q ? '搜索结果' : '所有项目')} · 任务空间`; }, [task?.title, project?.name, route.q]);
  function navigate(next: Route, replace = false, focusHeading = true) {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', hrefFor(next)); setRoute(next);
    if (!replace) { window.scrollTo({ top: 0 }); if (focusHeading) requestAnimationFrame(() => document.getElementById('page-title')?.focus({ preventScroll: true })); }
  }
  function search(value: string) { navigate({ q: value || undefined }, !route.project && !route.task, false); }
  function refresh() { setRevision(value => value + 1); }
  const missing = route.task && !task || route.project && !project;
  return <div className="viewer-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="viewer-header"><div className="header-inner"><NavLink route={{}} navigate={navigate} className="viewer-brand" label="任务空间 · 所有项目"><Brand /></NavLink><div className="global-search" role="search"><label className="sr-only" htmlFor="workspace-search">搜索项目、任务或内容</label><div className="search-field"><Icon name="search" size={19} /><input id="workspace-search" type="search" placeholder="搜索项目、任务或内容" autoComplete="off" maxLength={150} value={route.q ?? ''} onChange={event => search(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') search(''); }} />{route.q ? <button className="clear-search" aria-label="清除搜索" onClick={() => search('')}><Icon name="close" size={16} /></button> : null}</div></div></div></header>
    <main id="main-content" className="viewer-main" tabIndex={-1}>
      {workspace.loading ? <><Heading title="所有项目" /><Loading label="正在读取本机 Codex 项目与完整历史…" /></> : null}
      {workspace.error ? <><Heading title="本机项目" /><Failure message={workspace.error} retry={workspace.refresh} /></> : null}
      {catalog && !workspace.loading && !workspace.error ? <>
        {missing ? <><Breadcrumbs project={project} navigate={navigate} /><Heading title={route.task ? '未找到这个任务' : '未找到这个项目'} /><Empty title="内容暂不可用" action={<button className="text-button" onClick={() => navigate({})}>返回所有项目</button>}>请返回首页查看本机已有项目与任务。</Empty></> :
          task ? <TaskDetails key={task.id} task={task} project={project} children={hierarchy.childrenByRootId.get(task.id) ?? []} navigate={navigate} revision={revision} highlightTurn={route.turn} selectedChild={selectedChild} /> :
            project ? <ProjectTasks key={project.id} project={project} tasks={projectTasks} navigate={navigate} /> :
              route.q?.trim() ? query === route.q.trim() ? <SearchResults hierarchy={hierarchy} query={query} navigate={navigate} revision={revision} /> : <><Heading title="搜索结果" /><Loading label="准备检索全部正文…" /></> : <><Heading title="所有项目" count={`${projectCount} 个项目`} action={archive ? <ArchiveLink project={archive} navigate={navigate} /> : undefined} />{savedProjects.length ? <div className="card-grid project-grid">{savedProjects.map(item => <ProjectCard key={item.id} project={item} navigate={navigate} />)}</div> : <Empty title="还没有项目">本机 Codex 的已有项目与任务将在这里展示。</Empty>}</>}
      </> : null}
    </main>
    <footer className="viewer-footer"><div className="footer-reading">{catalog ? <span>{projectCount} 个项目 · {hierarchy.tasks.length} 个任务<small>读取于 {formatTime(catalog.coverage.readAt)}</small></span> : null}<button className="refresh-reading" title="重新读取本机 Codex 记录" aria-label="重新读取本机 Codex 记录" disabled={workspace.loading} onClick={refresh}><Icon name="refresh" size={17} /></button></div></footer>
  </div>;
}
