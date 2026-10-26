import type { Overview, Project } from '../../../shared/contracts.ts';
import { api } from '../api.ts';
import { useQuery } from '../hooks.ts';
import { formatTime } from '../model.ts';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { Badge, EmptyState, ErrorNotice, Loading, PageHeading } from '../components/Ui.tsx';

export function OverviewPage({ overview, projectId, projects, refreshKey, onNavigate, onTask, onCreate }: { overview: Overview; projectId: string; projects: Project[]; refreshKey: number; onNavigate: (page: 'search' | 'tasks' | 'data') => void; onTask: (id: string) => void; onCreate: () => void }) {
  const tasks = useQuery(`overview-tasks:${projectId}:${refreshKey}`, signal => api.tasks({ projectId }, signal));
  const stats: { title: string; value: number; detail: string; icon: IconName; page: 'search' | 'tasks' | 'data' }[] = [
    { title: '可查询记录', value: overview.records, detail: '保留原文与来源', icon: 'search', page: 'search' },
    { title: '任务草稿', value: overview.drafts, detail: '等待核对并应用', icon: 'file', page: 'tasks' },
    { title: '待人工验收', value: overview.pendingAcceptance, detail: '验证与验收分别记录', icon: 'shield', page: 'tasks' },
    { title: '来源待确认', value: overview.unknownSources, detail: '保留未知，不自动归属', icon: 'filter', page: 'search' },
  ];
  return <>
    <PageHeading eyebrow="YOUR WORK, IN CONTEXT" title="把每次修改，连成清晰的任务" actions={<button className="button button-primary" onClick={onCreate}><Icon name="plus" />新建任务</button>}>从原始要求到执行结果，再到你确认的验收。所有记录集中在这里。</PageHeading>
    <p className="field-hint">工作台总览 · 以下统计覆盖全部项目</p><div className="stats-grid">{stats.map(stat => <button className="stat-card" key={stat.title} onClick={() => onNavigate(stat.page)}><div className="stat-top"><span>{stat.title}</span><Icon name={stat.icon} size={20} /></div><strong>{stat.value.toLocaleString('zh-CN')}</strong><div className="stat-bottom"><span>{stat.detail}</span><Icon name="arrow" size={16} /></div></button>)}</div>
    <div className="overview-grid"><section className="panel recent-tasks"><div className="panel-heading"><div><h2>继续核对任务</h2><p>{projects.find(project => project.id === projectId)?.name ?? '全部项目'} · 当前有效任务</p></div><button className="text-button" onClick={() => onNavigate('tasks')}>查看全部<Icon name="arrow" size={15} /></button></div><ErrorNotice message={tasks.error} retry={tasks.refresh} />{tasks.loading ? <Loading /> : tasks.data?.length ? <div className="compact-task-list">{tasks.data.slice(0, 5).map(task => <button className="compact-task" key={task.id} onClick={() => onTask(task.id)}><div className="task-monogram"><Icon name="tasks" /></div><div className="compact-task-name"><strong>{task.title}</strong><small>{task.currentRevisionId ? `版本 v${task.revisionNumber}` : '初始草稿'} · {formatTime(task.updatedAt)}</small></div><Badge value={task.acceptance} /><Icon name="chevron" size={16} /></button>)}</div> : <EmptyState title="还没有待核对的任务" icon="tasks" action={<button className="button" onClick={onCreate}>创建第一张任务卡</button>}>清楚写下本次目标与验收标准，后续修改会保留为新版本。</EmptyState>}</section>
      <section className="panel workflow-panel"><div className="panel-heading"><div><h2>一个可追溯的闭环</h2><p>在工作台整理，在 Codex 中执行</p></div></div><ol className="workflow-list"><li><span>01</span><div><strong>找回原始要求</strong><p>导入历史，按原文检索并确认来源。</p></div></li><li><span>02</span><div><strong>确定当前任务版本</strong><p>核对草稿、范围与验收标准后激活。</p></div></li><li><span>03</span><div><strong>把结果带回任务</strong><p>用交接包执行，导入对应版本回执。</p></div></li><li><span>04</span><div><strong>依据证据验收</strong><p>逐项核对，保留你的人工验收决定。</p></div></li></ol><button className="button button-full" onClick={() => onNavigate('data')}><Icon name="database" />管理数据与导入</button></section></div>
    <section className="source-health"><div><Icon name="shield" size={21} /><div><strong>本地数据，明确来源</strong><p>{overview.diagnostics.length ? `${overview.diagnostics.length} 条采集诊断需要留意；存在缺口的历史会保留提示。` : '原始历史只读。当前没有采集诊断，这不代表所有历史已完整导入。'}</p></div></div><button className="text-button" onClick={() => onNavigate('data')}>查看来源状态<Icon name="arrow" size={16} /></button></section>
  </>;
}
