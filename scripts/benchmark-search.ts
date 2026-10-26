import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { cpus, totalmem, release, tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchStore } from '../server/domain/store.ts';
import type { SearchOptions, SourceRecord } from '../shared/contracts.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryParent = await realpath(tmpdir());
const folder = await mkdtemp(join(temporaryParent, 'ctw-benchmark-'));
const databaseFile = join(folder, 'benchmark.sqlite');
const store = new WorkbenchStore(databaseFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const startedAt = new Date().toISOString();
const setupStarted = performance.now();
let indexedBytes = 0;
try {
  const project = store.createProject({ name: '合成性能测试' });
  const padding = '索引材料包含目标范围验收标准以及执行证据。'.repeat(34);
  for (let start = 0; start < 50_000; start += 1_000) {
    const records: SourceRecord[] = [];
    for (let index = start; index < start + 1_000; index++) {
      const text = `记录${index}：修改任务，查询历史指令并核对结果。文件 src/search-${index % 20}.tsx。编号[AC-${index % 9}]，100%完成？ ${padding}`;
      const raw = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      indexedBytes += Buffer.byteLength(text);
      records.push({ id: `bench-source-${index}`, projectId: project.id, sessionId: `bench-session-${Math.floor(index / 100)}`, turnId: `turn-${index}`, eventId: `event-${index}`, sequence: index,
        timestamp: '2026-10-26T00:00:00Z', role: 'user', sourceKind: 'root', attribution: 'unknown', inherited: false, kind: 'message', text, raw,
        filePath: 'synthetic-benchmark.jsonl', line: index + 1, hash: hash(raw), archived: index % 10 === 0, changes: [] });
    }
    store.importHistory(project.id, { records, diagnostics: [], files: [] });
    if ((start + 1_000) % 10_000 === 0) console.log(`已生成 ${start + 1_000} 条合成记录`);
  }
  for (let index = 0; index < 2_000; index++) {
    const detail = store.createTask({ projectId: project.id, title: `检索任务 ${index}`, content: { goal: `查询编号 ${index} 的修改指令`, requirements: ['保留原始内容', '中文查询可定位'], scope: '本地历史', nonGoals: '云端同步', criteria: [{ id: 'AC-01', text: '能定位原始来源', required: true }], sourceIds: [`bench-source-${index}`], conflicts: [] } });
    store.activateDraft(detail.task.id, detail.task.lockVersion);
  }
  const setupMs = performance.now() - setupStarted;
  const words = ['改', '任务', '历史指令', 'src/search-1.tsx', '[AC-2]', '100%', '不存在的词', '范围', '验收标准', '证据'];
  const queries: SearchOptions[] = ['instructions', 'all', 'tasks'].flatMap(scope => words.map(q => ({ q, projectId: project.id, scope: scope as SearchOptions['scope'], archived: true, limit: 50 })));
  // 每组查询先预热一次；计时含精确总数、排序和首屏结果对象构造。
  for (const query of queries) store.search(query);
  const results = queries.map(query => {
    const start = performance.now(); const result = store.search(query);
    return { ...query, total: result.total, ms: Number((performance.now() - start).toFixed(3)) };
  });
  const times = results.map(r => r.ms).sort((a, b) => a - b);
  const report = { startedAt, finishedAt: new Date().toISOString(), synthetic: true, runtime: process.version, platform: `${process.platform} ${release()}`,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    generatedSourceRecords: 50_000, totalStoredRecords: store.getOverview().records, tasks: 2_000, sourceTextBytes: indexedBytes, sourceTextMiB: Number((indexedBytes / 1024 ** 2).toFixed(2)),
    setupMs: Math.round(setupMs), queryCount: results.length, p95Ms: times[Math.ceil(times.length * .95) - 1], maxMs: times.at(-1), targetP95Ms: 2_000,
    measurement: '本机领域服务：30组查询各预热一次后计时；包括计数、排序、分页和对象构造，不包括浏览器渲染；人工查找时长另行评估。', results };
  await mkdir(join(projectRoot, 'evidence'), { recursive: true });
  await writeFile(join(projectRoot, 'evidence', 'search-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sourceTextMiB: report.sourceTextMiB, records: report.totalStoredRecords, tasks: report.tasks, p95Ms: report.p95Ms, passed: report.p95Ms <= report.targetP95Ms }));
} finally {
  store.close();
  const resolved = await realpath(folder);
  const child = relative(temporaryParent, resolved);
  if (!child.startsWith('ctw-benchmark-') || child.includes('..') || isAbsolute(child) || child.includes('/') || child.includes('\\')) throw new Error('临时目录边界检查失败，保留性能测试数据库');
  await stat(join(resolved, 'benchmark.sqlite'));
  await rm(resolved, { recursive: true, force: true });
}
