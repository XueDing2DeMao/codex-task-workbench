import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const policy = require('../desktop/policy.cjs');
const { createService } = require('../desktop/lifecycle.cjs');
const { readPreferences, savePreferences, closeChoice } = require('../desktop/preferences.cjs');

test('桌面只接受本次服务回环地址，外链和下载均限制协议与来源', () => {
  assert.equal(policy.serviceOrigin('http://127.0.0.1:43127'), 'http://127.0.0.1:43127');
  for (const value of ['https://127.0.0.1:43127', 'http://example.com:43127', 'file:///tmp/a', 'http://user@127.0.0.1:43127', 'http://127.0.0.1:43127/path', 'http://127.0.0.1:43127/?secret=1']) {
    assert.throws(() => policy.serviceOrigin(value));
  }
  const origin = 'http://127.0.0.1:43127';
  assert.equal(policy.sameOrigin(origin + '/?task=a', origin), true);
  assert.equal(policy.sameOrigin('http://127.0.0.1:43128/', origin), false);
  assert.equal(policy.externalUrl('https://example.com/paper?q=1'), true);
  for (const value of ['file:///C:/private', 'javascript:alert(1)', 'data:text/html,hello', 'https://a:b@example.com']) assert.equal(policy.externalUrl(value), false);
  assert.equal(policy.allowedDownload('blob:' + origin + '/abc', origin), true);
  for (const value of ['blob:http://127.0.0.1:43128/abc', 'https://example.com/file.md', origin + '/api/backup', 'data:text/plain,hello']) assert.equal(policy.allowedDownload(value, origin), false);
  assert.equal(policy.markdownFilename('C:\\private\\任务.md'), '任务.md');
  assert.equal(policy.markdownFilename('report.exe'), 'report.exe.md');
});

test('剪贴板只允许当前聚焦窗口的同源主页面写入，读取及其他来源全拒绝', () => {
  const origin = 'http://127.0.0.1:43210';
  const context = { senderMatches: true, destroyed: false, focused: true, currentUrl: origin + '/?task=one', details: { isMainFrame: true, requestingUrl: origin + '/?task=one' } };
  assert.equal(policy.clipboardWriteAllowed('clipboard-sanitized-write', context, origin), true);
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'openExternal', 'unknown']) {
    assert.equal(policy.clipboardWriteAllowed(permission, context, origin), false);
  }
  for (const changed of [
    { senderMatches: false }, { destroyed: true }, { focused: false }, { currentUrl: 'https://example.com' },
    { details: { isMainFrame: false, requestingUrl: origin + '/' } },
    { details: { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43211/' } },
    { details: { isMainFrame: true, requestingUrl: 'https://example.com' } },
    { details: { isMainFrame: true } }, { details: undefined },
  ]) assert.equal(policy.clipboardWriteAllowed('clipboard-sanitized-write', { ...context, ...changed }, origin), false);
});

test('桌面权限回调开放受限写入，check额外核对requestingOrigin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-desktop-clipboard-'));
  let requestHandler!: (sender: unknown, permission: string, callback: (allowed: boolean) => void, details: Record<string, unknown>) => void;
  let checkHandler!: (sender: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean;
  let destroyed = false; let focused = true;
  const origin = 'http://127.0.0.1:43210';
  const session = {
    setPermissionRequestHandler(handler: typeof requestHandler) { requestHandler = handler; },
    setPermissionCheckHandler(handler: typeof checkHandler) { checkHandler = handler; },
    on() {},
  };
  const contents = { session, isDestroyed: () => destroyed, isFocused: () => focused, getURL: () => origin + '/', on() {}, setWindowOpenHandler() {} };
  const electron = { app: { setName() {}, setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => false, quit() {} } };
  const mainPath = resolve('desktop/main.cjs'); const mainRequire = createRequire(mainPath);
  const context = createContext({ require: (name: string) => name === 'electron' ? electron : mainRequire(name), process: { env: { ...process.env, CTW_DATA_DIR: root } }, testWindow: { webContents: contents } });
  try {
    runInContext(await readFile(mainPath, 'utf8'), context, { filename: mainPath });
    runInContext(`window = testWindow; protectWindow('${origin}');`, context);
    const details = { isMainFrame: true, requestingUrl: origin + '/?task=one' };
    let granted = false;
    requestHandler(contents, 'clipboard-sanitized-write', allowed => { granted = allowed; }, details);
    assert.equal(granted, true);
    assert.equal(checkHandler(contents, 'clipboard-sanitized-write', origin, details), true);
    assert.equal(checkHandler(contents, 'clipboard-sanitized-write', 'https://example.com', details), false);
    assert.equal(checkHandler(contents, 'clipboard-sanitized-write', 'http://127.0.0.1:43211', details), false);
    assert.equal(checkHandler(contents, 'clipboard-read', origin, details), false);
    focused = false;
    requestHandler(contents, 'clipboard-sanitized-write', allowed => { granted = allowed; }, details);
    assert.equal(granted, false);
    focused = true; destroyed = true;
    assert.equal(checkHandler(contents, 'clipboard-sanitized-write', origin, details), false);
  } finally { await cleanup(root); }
});

test('关闭偏好默认询问，损坏配置安全回退；仅有效选择可持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-desktop-preference-'));
  const path = join(root, 'preferences.json');
  try {
    assert.equal(readPreferences(path).closeAction, 'prompt');
    await writeFile(path, '{broken');
    assert.equal(readPreferences(path).closeAction, 'prompt');
    savePreferences(path, 'minimize');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { closeAction: 'minimize' });
    assert.equal(readPreferences(path).closeAction, 'minimize');
    savePreferences(path, 'quit');
    assert.equal(readPreferences(path).closeAction, 'quit');
    savePreferences(path, 'prompt');
    assert.equal(readPreferences(path).closeAction, 'prompt');
    assert.throws(() => savePreferences(path, 'delete'));
    assert.equal(readPreferences(path).closeAction, 'prompt');
  } finally { await cleanup(root); }
});

test('关闭对话框取消不保存偏好，记住选择只适用于托盘或退出', () => {
  assert.deepEqual(closeChoice({ response: 0, checkboxChecked: false }), { action: 'minimize' });
  assert.deepEqual(closeChoice({ response: 1, checkboxChecked: true }), { action: 'quit', remember: 'quit' });
  assert.deepEqual(closeChoice({ response: 0, checkboxChecked: true }), { action: 'minimize', remember: 'minimize' });
  assert.deepEqual(closeChoice({ response: 2, checkboxChecked: true }), { action: 'cancel' });
});

test('保存关闭偏好失败时菜单回滚到实际配置，隐藏托盘窗口恢复后显示错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctw-desktop-menu-'));
  const profile = join(root, 'desktop-profile');
  // 用目录占据配置文件名，触发真实的原子重命名失败，不伪造保存函数结果。
  await mkdir(join(profile, 'preferences.json'), { recursive: true });
  type MenuEntry = { label?: string; submenu?: MenuEntry[]; checked?: boolean; click?: () => void };
  let applicationMenu: MenuEntry[] = []; let trayMenu: MenuEntry[] = [];
  let visible = false; let messageVisible = false; let messageTitle = '';
  const windowMock = { isDestroyed: () => false, isMinimized: () => false, restore() {}, show() { visible = true; }, focus() {} };
  const trayMock = { isDestroyed: () => false, setContextMenu(menu: MenuEntry[]) { trayMenu = menu; } };
  const electron = {
    app: { setName() {}, setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
    Menu: { buildFromTemplate: (template: MenuEntry[]) => template, setApplicationMenu(menu: MenuEntry[]) { applicationMenu = menu; } },
    dialog: { showMessageBox(_window: unknown, options: { title: string }) { messageVisible = visible; messageTitle = options.title; return Promise.resolve({ response: 0 }); } },
  };
  const mainPath = resolve('desktop/main.cjs');
  const mainRequire = createRequire(mainPath);
  const context = createContext({
    require: (name: string) => name === 'electron' ? electron : mainRequire(name),
    process: { env: { ...process.env, CTW_DATA_DIR: root } },
    windowMock, trayMock,
  });
  try {
    runInContext(await readFile(mainPath, 'utf8'), context, { filename: mainPath });
    runInContext('window = windowMock; tray = trayMock; rebuildMenus();', context);
    const clickedGroup = trayMenu.find(item => item.label === '关闭行为设置')!.submenu!;
    // Electron radio 会在调用 click 处理器之前切换选中项。
    for (const item of clickedGroup) item.checked = item.label === '最小化到托盘';
    clickedGroup.find(item => item.label === '最小化到托盘')!.click!();
    const appGroup = applicationMenu.find(item => item.label === '设置')!.submenu![0].submenu!;
    const trayGroup = trayMenu.find(item => item.label === '关闭行为设置')!.submenu!;
    assert.equal(appGroup.find(item => item.checked)?.label, '每次询问');
    assert.equal(trayGroup.find(item => item.checked)?.label, '每次询问');
    assert.equal(readPreferences(join(profile, 'preferences.json')).closeAction, 'prompt');
    assert.equal(messageTitle, '设置未保存');
    assert.equal(messageVisible, true, '托盘隐藏状态下必须先恢复窗口，再显示保存错误');
  } finally { await cleanup(root); }
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'ctw-desktop-child-'));
  const entry = join(root, 'worker.cjs');
  await writeFile(entry, source);
  return { root, entry };
}
async function cleanup(root: string) {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true });
}

test('后台就绪后可以优雅停止，关闭操作幂等且等待真实进程退出', async () => {
  const { root, entry } = await fixture(`
process.send({type:'ready',url:'http://127.0.0.1:43210'});
process.on('message', message => { if (message.type === 'shutdown') { require('node:fs').writeFileSync('closed.txt', 'closed'); process.exit(0); } });
`);
  const service = createService({ nodePath: process.execPath, entryPoint: entry, cwd: root });
  try {
    assert.equal(await service.ready, 'http://127.0.0.1:43210');
    await Promise.all([service.stop(), service.stop()]);
    assert.equal(await readFile(join(root, 'closed.txt'), 'utf8'), 'closed');
    assert.equal(service.child.exitCode, 0);
  } finally { await service.stop(); await cleanup(root); }
});

test('启动失败与错误就绪地址明确拒绝，启动中的后台仍可清理', async () => {
  for (const source of [
    `process.send({type:'error',message:'合成启动错误'}); setInterval(()=>{},1000);`,
    `process.send({type:'ready',url:'https://example.com'}); setInterval(()=>{},1000);`,
  ]) {
    const { root, entry } = await fixture(source);
    const service = createService({ nodePath: process.execPath, entryPoint: entry, cwd: root, stopTimeoutMs: 80 });
    try { await assert.rejects(service.ready); }
    finally { await service.stop(); assert.ok(service.child.exitCode !== null || service.child.signalCode !== null); await cleanup(root); }
  }
});

test('后台超时仅终止本次子进程，运行后异常退出会通知主窗口', async () => {
  const hanging = await fixture('setInterval(()=>{},1000);');
  const service = createService({ nodePath: process.execPath, entryPoint: hanging.entry, cwd: hanging.root, startupTimeoutMs: 80, stopTimeoutMs: 80 });
  try { await assert.rejects(service.ready, /超时/); }
  finally { await service.stop(); await cleanup(hanging.root); }
  const crashing = await fixture(`process.send({type:'ready',url:'http://127.0.0.1:43210'}); setTimeout(()=>process.exit(7),100);`);
  let notify!: (error: Error) => void;
  const failure = new Promise<Error>(done => { notify = done; });
  const failed = createService({ nodePath: process.execPath, entryPoint: crashing.entry, cwd: crashing.root, onUnexpectedExit: notify });
  try { await failed.ready; assert.match((await failure).message, /7/); }
  finally { await failed.stop(); await cleanup(crashing.root); }
});
