import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// 只允许隔离空目录与本机 CLI 协议自省；不导入真实日志、认证或内部数据库。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(projectRoot, 'evidence');
await mkdir(evidenceRoot, { recursive: true });
const runtime = await mkdtemp(join(evidenceRoot, 'probe-runtime-'));
const home = join(runtime, 'home');
const temp = join(runtime, 'temp');
const schemas = join(runtime, 'schema');
await Promise.all([mkdir(home), mkdir(temp), mkdir(schemas)]);
const env: NodeJS.ProcessEnv = {
  Path: process.env.Path || process.env.PATH,
  SystemRoot: process.env.SystemRoot || 'C:\\Windows',
  COMSPEC: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
  TEMP: temp, TMP: temp, CODEX_HOME: home, HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
};
await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
const exe = process.argv[2] || 'codex';
const cli = (args: string[]) => {
  const result = spawnSync(exe, args, { cwd: home, env, windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  return { args, exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
};
const report: Record<string, any> = {
  checkedAt: new Date().toISOString(), kind: 'isolated CLI schema and empty-history read-only protocol probe',
  isolatedHome: home, sourceHistoryRead: false, realAuthRead: false, modelTurnStarted: false,
  limitations: ['Only a new empty CODEX_HOME is used. No existing desktop database or live conversation is accessed.', 'Method availability is not evidence of complete real-history or pagination compatibility.'],
  commands: [], schemas: {}, protocol: [],
};
report.commands.push(cli(['--version']), cli(['app-server', '--help']));
const generation = cli(['app-server', 'generate-json-schema', '--experimental', '--out', schemas]);
report.commands.push(generation);
async function schemaPaths(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await schemaPaths(path));
    else if (/Thread(List|Read|TurnsList|ItemsList)Params\.json$/u.test(entry.name)) result.push(path);
  }
  return result;
}
if (generation.exitCode === 0) for (const path of await schemaPaths(schemas)) {
  const schema = JSON.parse(await readFile(path, 'utf8'));
  report.schemas[path.split(/[\\/]/u).at(-1)!] = { path, required: schema.required || [], properties: schema.properties || {} };
}

if (!process.argv.includes('--schema-only') && generation.exitCode === 0) {
  const child = spawn(exe, ['app-server', '--stdio'], { cwd: home, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0; let buffered = ''; let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 20_000) stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    buffered += chunk.toString();
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n'); const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try {
        const message = JSON.parse(line); const request = pending.get(message.id);
        if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
      } catch { /* stderr/非协议行不会被当成成功。 */ }
    }
  });
  child.on('error', error => { report.spawnError = error.message; });
  const allowed = new Set(['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list']);
  async function rpc(method: string, params: unknown) {
    if (!allowed.has(method)) throw new Error('Probe method denied');
    const id = ++counter;
    const response = new Promise(resolveResponse => {
      const timer = setTimeout(() => { pending.delete(id); resolveResponse({ error: { message: 'probe timeout' } }); }, 8_000);
      pending.set(id, { resolve: resolveResponse, timer });
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const value = await response;
    report.protocol.push({ method, params, response: value });
    return value as any;
  }
  try {
    const initialized = await rpc('initialize', { clientInfo: { name: 'codex_task_workbench_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    if (initialized.result) {
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      await rpc('thread/list', { limit: 1, archived: false, useStateDbOnly: true });
      await rpc('thread/list', { limit: 1, archived: true, useStateDbOnly: true });
      const threadId = randomUUID();
      await rpc('thread/read', { threadId, includeTurns: false });
      await rpc('thread/turns/list', { threadId, limit: 1 });
      await rpc('thread/items/list', { threadId, turnId: randomUUID(), limit: 1 });
    }
  } finally {
    child.stdin.end();
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null) { resolveExit(); return; }
      const timer = setTimeout(() => { child.kill(); resolveExit(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
    for (const request of pending.values()) clearTimeout(request.timer);
    report.serverStderr = stderr;
  }
}
report.completedAt = new Date().toISOString();
const output = join(evidenceRoot, 'probe-history.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, version: report.commands[0].stdout.trim(), schemaFiles: Object.keys(report.schemas), protocol: report.protocol.map((row: any) => ({ method: row.method, result: row.response?.error || 'response received' })) }, null, 2));
