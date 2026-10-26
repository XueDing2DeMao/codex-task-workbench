import type { NativeSearchResult, NativeTaskSummary } from '../../../shared/native-contracts.ts';

export interface TaskHierarchy {
  tasks: NativeTaskSummary[];
  rootByTaskId: Map<string, NativeTaskSummary>;
  childrenByRootId: Map<string, NativeTaskSummary[]>;
  unassigned: NativeTaskSummary[];
}
export interface GroupedTaskSummary extends NativeTaskSummary {
  matchChildId?: string;
  matchSourceTitle?: string;
}

// 仅依赖明确的父子关系，不按项目、时间或相似标题猜测归属。
export function buildTaskHierarchy(records: NativeTaskSummary[]): TaskHierarchy {
  const byId = new Map(records.map(task => [task.id, task]));
  const tasks = records.filter(task => task.source === 'user');
  const rootByTaskId = new Map(tasks.map(task => [task.id, task]));
  const childrenByRootId = new Map<string, NativeTaskSummary[]>();
  const unassigned: NativeTaskSummary[] = [];
  for (const task of records) {
    if (task.source === 'user') continue;
    const visited = new Set<string>();
    let current: NativeTaskSummary | undefined = task;
    while (current && current.source !== 'user' && !visited.has(current.id)) {
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!current || current.source !== 'user') { unassigned.push(task); continue; }
    rootByTaskId.set(task.id, current);
    const children = childrenByRootId.get(current.id) ?? [];
    children.push(task);
    childrenByRootId.set(current.id, children);
  }
  return { tasks, rootByTaskId, childrenByRootId, unassigned };
}

export function groupSearchResults(result: NativeSearchResult, hierarchy: TaskHierarchy): Omit<NativeSearchResult, 'tasks'> & { tasks: GroupedTaskSummary[] } {
  const grouped = new Map<string, GroupedTaskSummary>();
  for (const hit of result.tasks) {
    const root = hierarchy.rootByTaskId.get(hit.id);
    if (!root) continue;
    const direct = hit.id === root.id;
    // 一个主任务只占一张卡；主任务正文也命中时优先进入主任务。
    if (grouped.has(root.id) && !direct) continue;
    grouped.set(root.id, {
      ...root, matchExcerpt: hit.matchExcerpt, matchTurnId: hit.matchTurnId,
      matchChildId: direct ? undefined : hit.id,
      matchSourceTitle: direct ? undefined : hit.title,
    });
  }
  const counts = new Map<string, number>();
  for (const task of hierarchy.tasks) counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  const projects = result.projects.map(project => ({ ...project, taskCount: counts.get(project.id) ?? 0 }));
  const tasks = [...grouped.values()];
  return { ...result, projects, tasks, total: projects.length + tasks.length };
}
