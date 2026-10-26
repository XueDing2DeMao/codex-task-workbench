const { win32 } = require('node:path');

function parse(value) {
  try { return new URL(value); } catch { return null; }
}

function serviceOrigin(value) {
  const url = parse(value);
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('后台服务返回的地址无效。');
  }
  return url.origin;
}

function sameOrigin(value, origin) {
  const url = parse(value);
  return Boolean(url && url.protocol === 'http:' && url.origin === origin && !url.username && !url.password);
}

function externalUrl(value) {
  const url = parse(value);
  return Boolean(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
}

function allowedDownload(value, origin) {
  const url = parse(value);
  return Boolean(url && url.protocol === 'blob:' && url.origin === origin);
}

function clipboardWriteAllowed(permission, context, origin) {
  return Boolean(permission === 'clipboard-sanitized-write'
    && context.senderMatches && !context.destroyed && context.focused
    && context.details?.isMainFrame === true
    && sameOrigin(context.currentUrl, origin)
    && sameOrigin(context.details.requestingUrl, origin));
}

function markdownFilename(value) {
  const name = win32.basename(value || '任务导出.md').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').slice(0, 160) || '任务导出';
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

module.exports = { serviceOrigin, sameOrigin, externalUrl, allowedDownload, clipboardWriteAllowed, markdownFilename };
