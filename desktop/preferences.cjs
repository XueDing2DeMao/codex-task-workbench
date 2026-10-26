const { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const closeActions = new Set(['prompt', 'minimize', 'quit']);

function readPreferences(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return { closeAction: closeActions.has(value?.closeAction) ? value.closeAction : 'prompt' };
  } catch { return { closeAction: 'prompt' }; }
}

function savePreferences(path, closeAction) {
  if (!closeActions.has(closeAction)) throw new Error('无效的关闭行为。');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ closeAction }, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function closeChoice({ response, checkboxChecked }) {
  const action = response === 0 ? 'minimize' : response === 1 ? 'quit' : 'cancel';
  return { action, ...(checkboxChecked && action !== 'cancel' ? { remember: action } : {}) };
}

module.exports = { readPreferences, savePreferences, closeChoice };
