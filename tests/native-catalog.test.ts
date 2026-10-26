import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeCatalog } from '../server/native/catalog.ts';

async function fixture(t: any) {
  const home = await mkdtemp(join(tmpdir(), 'ctw-native-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,cwd TEXT,source TEXT,thread_source TEXT,agent_path TEXT,project_id TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,rollout_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);`);
  const project = (id: string, name: string, path: string, position = 0) => { db.prepare('INSERT INTO projects VALUES(?,?,?)').run(id,name,position); db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run(id,0,path); };
  const thread = (id: string, extra: Record<string, unknown> = {}) => {
    const row = { id, title: `任务 ${id}`, name: null, cwd: 'C:\\old\\workspace', source: 'vscode', thread_source: 'user', agent_path: null, project_id: null, archived: 0, created_at: 1792960000, updated_at: 1792960001, created_at_ms: null, updated_at_ms: null, rollout_path: join(home, `${id}.jsonl`), ...extra };
    db.prepare(`INSERT INTO threads(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as any[]);
  };
  return { home, db, project, thread, state: (value: unknown) => writeFile(join(home, '.codex-global-state.json'), JSON.stringify(value)) };
}

test('原生项目含零任务，明确项目归属覆盖 cwd 并通过旧ID映射，原库不变', async t => {
  const f = await fixture(t); f.project('native-a','项目 A','C:\\code\\a'); f.project('native-b','项目 B','C:\\code\\b',1); f.thread('task-a',{cwd:'C:\\code\\b',name:'自定义标题'});
  await f.state({ 'thread-project-assignments': { 'task-a': {projectKind:'local',projectId:'legacy-a'} }, 'app-server-project-id-by-legacy-project-id-by-host': { [`local:${f.home}`]: {'legacy-a':'native-a'} } });
  f.db.close(); const before = await readFile(join(f.home,'state_5.sqlite'));
  const catalog = readNativeCatalog(f.home);
  assert.equal(catalog.projects.length,2); assert.equal(catalog.threads[0].projectId,'native-a'); assert.equal(catalog.threads[0].title,'自定义标题');
  assert.deepEqual(await readFile(join(f.home,'state_5.sqlite')),before);
});

test('按规范化 Windows 最长根路径归类，路径前缀不跨目录边界', async t => {
  const f=await fixture(t); f.project('outer','外层','C:\\CODE\\APP\\'); f.project('inner','内层','C:\\code\\app\\nested');
  f.thread('a',{cwd:'c:/code/app/nested/src/'}); f.thread('b',{cwd:'C:\\code\\apple'}); await f.state({}); f.db.close();
  const catalog=readNativeCatalog(f.home); assert.equal(catalog.threads.find(x=>x.id==='a')!.projectId,'inner');
  const b=catalog.threads.find(x=>x.id==='b')!; assert.equal(b.projectId,'native:archived'); assert.equal(catalog.projects.find(p=>p.id===b.projectId)!.name,'已归档');
});

test('显式无项目与不同历史目录统一归入已归档，不生成目录项目', async t => {
  const f=await fixture(t); f.project('a','项目 A','C:\\code\\a'); f.thread('loose',{cwd:'C:\\code\\a'}); f.thread('old1',{cwd:'D:\\legacy\\one'}); f.thread('old2',{cwd:'D:/legacy/two'});
  await f.state({'projectless-thread-ids':['loose']}); f.db.close(); const catalog=readNativeCatalog(f.home);
  const byId=new Map(catalog.threads.map(x=>[x.id,x])); assert.equal(byId.get('loose')!.projectId,'native:archived');
  assert.equal(byId.get('old1')!.projectId,'native:archived'); assert.equal(byId.get('old2')!.projectId,'native:archived');
  assert.deepEqual(catalog.projects.map(p=>p.name),['项目 A','已归档']);
});

test('子任务跟随父任务项目，guardian 单独标注，归档和压缩路径保留', async t => {
  const f=await fixture(t); f.project('p','项目','C:\\code\\p'); f.thread('root',{cwd:'C:\\code\\p'});
  f.thread('child',{cwd:'C:\\worktrees\\odd',source:JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'root'}}}),thread_source:'subagent',agent_path:'/root/worker',archived:1});
  f.thread('guardian',{source:JSON.stringify({subagent:{other:'guardian'}}),thread_source:'guardian_review'});
  await writeFile(join(f.home,'child.jsonl.zst'),'fixture'); await f.state({}); f.db.close(); const catalog=readNativeCatalog(f.home);
  const child=catalog.threads.find(x=>x.id==='child')!; assert.equal(child.projectId,'p'); assert.equal(child.parentId,'root'); assert.equal(child.source,'subagent'); assert.equal(child.archived,true); assert.ok(child.rolloutPath?.endsWith('.zst'));
  assert.equal(catalog.threads.find(x=>x.id==='guardian')!.source,'guardian');
});

test('过期归属进入已归档，损坏归属文件给出警告，不注入示例', async t => {
  const f=await fixture(t); f.thread('a'); await f.state({'thread-project-assignments':{'a':{projectKind:'local',projectId:'deleted'}}}); f.db.close();
  const first=readNativeCatalog(f.home); assert.equal(first.projects[0].name,'已归档'); assert.ok(first.warnings.length);
  await writeFile(join(f.home,'.codex-global-state.json'),'{broken'); const second=readNativeCatalog(f.home); assert.equal(second.threads.length,1); assert.ok(second.warnings.some(x=>x.includes('归属')));
});

test('原生项目表存在时不恢复旧状态里已删除的项目；过期明确归属不误挂同目录的新项目', async t => {
  const f=await fixture(t); f.project('current','当前项目','C:\\code\\shared');
  f.thread('stale',{cwd:'C:\\code\\shared'});
  await f.state({'local-projects':{deleted:{name:'已删除项目',rootPaths:['C:\\code\\shared']}},
    'thread-project-assignments':{stale:{projectKind:'local',projectId:'deleted'}}});
  f.db.close(); const catalog=readNativeCatalog(f.home);
  assert.deepEqual(catalog.projects.map(p=>p.name),['当前项目','已归档']);
  assert.equal(catalog.threads[0].projectId,'native:archived');
});

test('没有原生项目表时兼容本机保存项目，旧目录仍统一归档且原生归档标志保持原样', async t => {
  const f=await fixture(t); f.db.exec('DROP TABLE project_roots; DROP TABLE projects;');
  f.thread('saved',{cwd:'C:\\code\\saved',archived:1}); f.thread('legacy',{cwd:'D:\\history',archived:0});
  await f.state({'local-projects':{saved:{name:'保存项目',rootPaths:['C:\\code\\saved']}}});
  f.db.close(); const catalog=readNativeCatalog(f.home);
  assert.deepEqual(catalog.projects.map(p=>p.name),['保存项目','已归档']);
  assert.equal(catalog.threads.find(t=>t.id==='saved')!.projectId,'saved');
  assert.equal(catalog.threads.find(t=>t.id==='saved')!.archived,true);
  assert.equal(catalog.threads.find(t=>t.id==='legacy')!.projectId,'native:archived');
  assert.equal(catalog.threads.find(t=>t.id==='legacy')!.archived,false);
});

test('缺少原生库或不兼容线程 schema 明确失败', async t => {
  const home=await mkdtemp(join(tmpdir(),'ctw-missing-catalog-')); t.after(()=>rm(home,{recursive:true,force:true}));
  assert.throws(()=>readNativeCatalog(home),/state_5.sqlite/);
  const db=new DatabaseSync(join(home,'state_5.sqlite')); db.exec('CREATE TABLE threads(id TEXT)'); db.close();
  assert.throws(()=>readNativeCatalog(home),/结构|字段/);
});

test('空标题的子任务使用代理路径作显示标签，已有名称保持原样', async t => {
  const f=await fixture(t);
  f.thread('child-a',{title:'',name:null,thread_source:'subagent',agent_path:'/root/viewer_data'});
  f.thread('named',{title:'原始标题',name:'用户自定义标题',thread_source:'subagent',agent_path:'/root/review'});
  f.thread('empty-12345678',{title:'',name:null});
  await f.state({});f.db.close();const catalog=readNativeCatalog(f.home);
  assert.equal(catalog.threads.find(x=>x.id==='child-a')!.title,'子任务 · viewer_data');
  assert.equal(catalog.threads.find(x=>x.id==='named')!.title,'用户自定义标题');
  assert.match(catalog.threads.find(x=>x.id==='empty-12345678')!.title,/未命名任务 · empty-12/);
});
