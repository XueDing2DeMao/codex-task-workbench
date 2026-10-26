import type { NativeExportRequest, NativeExportResult, NativeProject, NativeTaskDetail } from '../../shared/native-contracts.ts';

export interface MarkdownTaskGroup { task: NativeTaskDetail; related: NativeTaskDetail[] }

// 只转义生成的标题与元数据；用户需求和输出正文保持原样。
function label(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1');
}
function localDate(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? '';
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}:${value('second')}`;
  return { display: `${day} ${time} +08:00`, stamp: `${day.replaceAll('-', '')}-${time.replaceAll(':', '')}` };
}
function safeFilename(value: string) {
  return Array.from(value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')).slice(0, 80).join('').replace(/[. ]+$/, '') || '任务';
}
function conversation(task: NativeTaskDetail, firstNumber = 1): string {
  if (!task.exchanges.length) return '暂无需求与输出';
  return task.exchanges.map((exchange, index) => {
    // 普通引用块在 Obsidian 实时预览中不完整渲染标题、表格等块级内容。
    const result = [`[!note] 第 ${index + firstNumber} 轮`, '**需求**'];
    if (!exchange.requirements.length) result.push('本轮未记录用户需求');
    exchange.requirements.forEach((text, requirementIndex) => {
      if (exchange.requirements.length > 1) result.push(`**需求 ${requirementIndex + 1}**`);
      result.push(text);
    });
    result.push('---', '**对应输出**');
    if (!exchange.outputs.length) result.push('暂无对应输出');
    exchange.outputs.forEach((output, outputIndex) => {
      if (exchange.outputs.length > 1) result.push(`**输出 ${outputIndex + 1}**`);
      result.push(output.text);
    });
    // 每行（包括空行）都留在卡片内，仅添加引用前缀，不改写原文或代码缩进。
    return result.join('\n\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n');
  }).join('\n\n---\n\n');
}
function taskMetadata(task: NativeTaskDetail) {
  return [`- 任务 ID：${label(task.id)}`, `- 需求轮数：${task.exchanges.length} 轮`,
    `- 输出数量：${task.exchanges.reduce((count, turn) => count + turn.outputs.length, 0)} 条`].join('\n');
}

export function formatNativeMarkdown(project: NativeProject, groups: MarkdownTaskGroup[], request: NativeExportRequest, readAt: string, exportedAt: Date): NativeExportResult {
  const date = localDate(exportedAt);
  const relatedCount = groups.reduce((count, group) => count + group.related.length, 0);
  const readDate = new Date(readAt);
  const sections = [
    `# ${label(project.name)}`,
    [`- 导出范围：${request.scope === 'project' ? '整个项目' : '所选任务'}`,
      `- 导出时间：${date.display}`,
      `- 数据读取时间：${Number.isNaN(readDate.getTime()) ? label(readAt) : localDate(readDate).display}`,
      `- 主任务：${groups.length} 个`,
      `- 需求轮数：${groups.reduce((count, group) => count + group.task.exchanges.length, 0)} 轮`,
      `- 输出数量：${groups.reduce((count, group) => count + group.task.exchanges.reduce((sum, turn) => sum + turn.outputs.length, 0), 0)} 条`,
      `- 子任务与审查：${request.includeRelated ? `${relatedCount} 个` : '未包含'}`,
    ].join('\n'),
  ];
  if (groups.length) {
    sections.push('## 任务目录', groups.map((group, index) => `${index + 1}. [${label(group.task.title)}](#task-${index + 1})`).join('\n'));
  } else sections.push('本项目暂无任务。');
  groups.forEach(({ task, related }, index) => {
    sections.push('---', `<a id="task-${index + 1}"></a>`, `## 任务 ${index + 1}：${label(task.title)}`, taskMetadata(task), conversation(task));
    if (related.length) sections.push('### 关联子任务与审查');
    related.forEach((child, childIndex) => {
      const kind = child.source === 'guardian' ? '审查任务' : child.source === 'subagent' ? '子任务' : '关联任务';
      sections.push(`#### ${childIndex + 1}. ${kind}：${label(child.title)}`, taskMetadata(child),
        `- 原始归档状态：${child.archived ? '已归档' : '未归档'}${child.parentId ? `\n- 父任务 ID：${label(child.parentId)}` : ''}`, conversation(child));
    });
  });
  const name = request.scope === 'project' ? `${project.name}_全部任务`
    : groups.length === 1 ? groups[0].task.title : `${project.name}_所选${groups.length}项任务`;
  return { filename: `${safeFilename(name)}_${date.stamp}.md`, markdown: sections.join('\n\n') + '\n', readAt, taskCount: groups.length };
}

export function formatNativeExchangeMarkdown(project: NativeProject, task: NativeTaskDetail, exchangeIndex: number, readAt: string, exportedAt: Date): NativeExportResult {
  const exchange = task.exchanges[exchangeIndex];
  const number = exchangeIndex + 1;
  const date = localDate(exportedAt);
  const readDate = new Date(readAt);
  const source = { user: '主任务', subagent: '子任务', guardian: '审查任务', unknown: '来源未知' }[task.source];
  const metadata = [
    `- 导出范围：第 ${number} 轮`,
    `- 任务 ID：${label(task.id)}`,
    `- 轮次 ID：${label(exchange.id)}`,
    `- 任务来源：${source}`,
    ...(task.parentId ? [`- 父任务 ID：${label(task.parentId)}`] : []),
    `- 需求数量：${exchange.requirements.length} 条`,
    `- 输出数量：${exchange.outputs.length} 条`,
    `- 导出时间：${date.display}`,
    `- 数据读取时间：${Number.isNaN(readDate.getTime()) ? label(readAt) : localDate(readDate).display}`,
  ];
  const markdown = [`# ${label(project.name)}`, `## 任务：${label(task.title)}`, metadata.join('\n'),
    conversation({ ...task, exchanges: [exchange] }, number)].join('\n\n') + '\n';
  return { filename: `${safeFilename(task.title)}_第${number}轮_${date.stamp}.md`, markdown, readAt, taskCount: 1 };
}
