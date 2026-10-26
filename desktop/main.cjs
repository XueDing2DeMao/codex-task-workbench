const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { mkdirSync } = require('node:fs');
const { createService } = require('./lifecycle.cjs');
const { sameOrigin, externalUrl, allowedDownload, clipboardWriteAllowed, markdownFilename } = require('./policy.cjs');
const { readPreferences, savePreferences, closeChoice } = require('./preferences.cjs');

app.setName('任务空间');
app.setAppUserModelId('local.codex.taskspace');
const localData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const profile = process.env.CTW_DATA_DIR
  ? join(resolve(process.env.CTW_DATA_DIR), 'desktop-profile')
  : join(localData, 'CodexTaskWorkbench', 'desktop-profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const preferencesPath = join(profile, 'preferences.json');
let preferences = readPreferences(preferencesPath);
let window; let service; let tray; let closePromptOpen = false; let quitting = false; let finished = false; let failureShown = false;

function restoreWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

function setCloseAction(action) {
  try { savePreferences(preferencesPath, action); preferences = { closeAction: action }; rebuildMenus(); }
  catch {
    // Electron radio 会先切换选中态；保存失败时以实际偏好重建菜单。
    rebuildMenus();
    restoreWindow();
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '设置未保存', message: '无法保存关闭偏好，请检查用户目录是否可写。', buttons: ['知道了'] });
  }
}

function closeSettings() {
  return [
    { label: '每次询问', action: 'prompt' },
    { label: '最小化到托盘', action: 'minimize' },
    { label: '退出程序', action: 'quit' },
  ].map(item => ({ label: item.label, type: 'radio', checked: preferences.closeAction === item.action, click: () => setCloseAction(item.action) }));
}

function rebuildMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '退出程序', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '设置', submenu: [{ label: '关闭窗口时', submenu: closeSettings() }] },
  ]));
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开任务空间', click: restoreWindow },
    { label: '关闭行为设置', submenu: closeSettings() },
    { type: 'separator' },
    { label: '退出程序', click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, 'assets', 'icon.png'));
    if (icon.isEmpty()) return;
    tray = new Tray(icon); tray.setToolTip('任务空间');
    tray.on('click', restoreWindow); tray.on('double-click', restoreWindow);
  } catch { tray = undefined; }
}

function minimizeWindow() {
  if (!window || window.isDestroyed()) return;
  // 托盘不可用时保留任务栏入口，避免窗口隐藏后无法恢复。
  if (tray && !tray.isDestroyed()) window.hide(); else window.minimize();
}

async function requestWindowClose(event) {
  if (quitting || finished) return;
  event.preventDefault();
  if (closePromptOpen) return;
  let action = preferences.closeAction;
  if (action === 'prompt') {
    closePromptOpen = true;
    try {
      const result = await dialog.showMessageBox(window, { type: 'question', title: '关闭任务空间', message: '关闭窗口时，你希望如何处理任务空间？', buttons: ['最小化到托盘', '退出程序', '取消'], defaultId: 0, cancelId: 2, noLink: true, checkboxLabel: '记住我的选择', checkboxChecked: false });
      const choice = closeChoice(result); action = choice.action;
      if (choice.remember) setCloseAction(choice.remember);
    } finally { closePromptOpen = false; }
  }
  if (action === 'minimize') minimizeWindow();
  else if (action === 'quit') app.quit();
}

function showFailure(error) {
  if (failureShown || quitting) return;
  failureShown = true;
  dialog.showErrorBox('任务空间暂时无法运行', error instanceof Error ? error.message : '发生了未知错误，请重新打开任务空间。');
  app.quit();
}

function openExternal(url) {
  if (externalUrl(url)) void shell.openExternal(url).catch(() => {
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '无法打开链接', message: '系统浏览器暂时无法打开此链接。', buttons: ['知道了'] });
  });
}

function protectWindow(origin) {
  const contents = window.webContents;
  const session = contents.session;
  const canWriteClipboard = (sender, permission, details) => {
    const destroyed = contents.isDestroyed();
    return clipboardWriteAllowed(permission, {
      senderMatches: sender === contents, destroyed,
      focused: !destroyed && contents.isFocused(),
      currentUrl: destroyed ? '' : contents.getURL(), details,
    }, origin);
  };
  session.setPermissionRequestHandler((sender, permission, callback, details) => callback(canWriteClipboard(sender, permission, details)));
  session.setPermissionCheckHandler((sender, permission, requestingOrigin, details) => sameOrigin(requestingOrigin, origin) && canWriteClipboard(sender, permission, details));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault(); openExternal(url);
  });
  contents.on('will-frame-navigate', event => { if (!sameOrigin(event.url, origin)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  session.on('will-download', (event, item, sender, frame) => {
    if (sender !== contents || contents.isDestroyed() || !sameOrigin(contents.getURL(), origin) || (frame && !sameOrigin(frame.url, origin)) || !allowedDownload(item.getURL(), origin)) {
      event.preventDefault(); return;
    }
    item.setSaveDialogOptions({ title: '导出 Markdown', defaultPath: join(app.getPath('downloads'), markdownFilename(item.getFilename())), filters: [{ name: 'Markdown 文档', extensions: ['md'] }], properties: ['showOverwriteConfirmation'] });
    item.once('done', (_event, state) => {
      if (state === 'interrupted' && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '导出未完成', message: '文件未能保存，请重新导出。', buttons: ['知道了'] });
    });
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!quitting && details.reason !== 'clean-exit') showFailure(new Error('显示进程意外结束，请重新打开任务空间。'));
  });
}

if (!app.requestSingleInstanceLock()) {
  finished = true; app.quit();
} else {
  app.on('second-instance', () => {
    restoreWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (service ? service.stop() : Promise.resolve()).finally(() => {
      if (tray && !tray.isDestroyed()) tray.destroy();
      finished = true; app.quit();
    });
  });
  app.whenReady().then(async () => {
    if (quitting) return;
    createTray(); rebuildMenus();
    const root = app.isPackaged ? join(process.resourcesPath, 'workbench') : resolve(__dirname, '..');
    const nodePath = app.isPackaged ? join(root, 'runtime', 'node.exe') : join(__dirname, '.runtime', 'node', 'node.exe');
    service = createService({ nodePath, entryPoint: join(root, 'desktop', 'server-entry.ts'), cwd: root, onUnexpectedExit: showFailure });
    const origin = await service.ready;
    if (quitting) return;
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 900, minHeight: 600, title: '任务空间', icon: join(__dirname, 'assets', 'icon.png'), show: false, backgroundColor: '#f7f7fb', autoHideMenuBar: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
    protectWindow(origin);
    window.on('close', event => { void requestWindowClose(event).catch(showFailure); });
    window.once('ready-to-show', () => { if (!quitting && !window.isDestroyed()) window.show(); });
    window.on('page-title-updated', event => event.preventDefault());
    await window.loadURL(origin);
  }).catch(showFailure);
}
