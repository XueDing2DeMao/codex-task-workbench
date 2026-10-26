const { spawn } = require('node:child_process');
const { serviceOrigin } = require('./policy.cjs');

/** 管理本窗口创建的服务进程，不寻找或终止其他任务空间实例。 */
function createService({ nodePath, entryPoint, cwd, environment = process.env, startupTimeoutMs = 20_000, stopTimeoutMs = 5_000, onUnexpectedExit = () => {} }) {
  const child = spawn(nodePath, [entryPoint], { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stopping = false; let closed = false; let settled = false; let started = false; let stopPromise;
  let resolveReady; let rejectReady; let resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completion = new Promise(resolve => { resolveClosed = resolve; });
  child.stderr.resume();
  const rejectStartup = error => {
    if (!settled) { settled = true; clearTimeout(startupTimer); rejectReady(error); }
  };
  const startupTimer = setTimeout(() => {
    rejectStartup(new Error('后台服务启动超时，请重新打开任务空间。'));
    void stop();
  }, startupTimeoutMs);
  child.on('message', message => {
    if (!message || typeof message !== 'object' || stopping) return;
    if (message.type === 'error') {
      const error = new Error(typeof message.message === 'string' ? message.message : '后台服务启动失败。');
      if (started) onUnexpectedExit(error); else rejectStartup(error);
      void stop();
    } else if (message.type === 'ready' && !settled) {
      try {
        const origin = serviceOrigin(message.url);
        settled = true; started = true; clearTimeout(startupTimer); resolveReady(origin);
      } catch (error) { rejectStartup(error); void stop(); }
    }
  });
  child.on('error', () => {
    const error = new Error('无法启动程序附带的运行环境，请完整解压任务空间后重试。');
    if (started && !stopping) onUnexpectedExit(error); else rejectStartup(error);
  });
  child.on('exit', (code, signal) => {
    const error = new Error(`后台服务已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}），请重新打开任务空间。`);
    if (!settled) rejectStartup(error);
    else if (started && !stopping) onUnexpectedExit(error);
  });
  child.on('close', () => { closed = true; clearTimeout(startupTimer); resolveClosed(); });

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    rejectStartup(new Error('后台启动已取消。'));
    stopPromise = (async () => {
      if (closed) return;
      if (child.connected) {
        try { child.send({ type: 'shutdown' }, () => {}); } catch { /* 已退出时等待 close 即可。 */ }
      }
      let forceTimer;
      try {
        forceTimer = setTimeout(() => { if (!closed && child.pid) child.kill(); }, stopTimeoutMs);
        await completion;
      } finally { clearTimeout(forceTimer); }
    })();
    return stopPromise;
  }
  return { child, ready, stop };
}

module.exports = { createService };
