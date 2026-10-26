import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest, validateImportPaths, assertAllowedKeys } from '../server/security.ts';

const secret = 'test-only-session-secret';
const request = (headers: Record<string, string> = {}, method = 'GET') => ({
  headers: { host: '127.0.0.1:43127', cookie: `ctw_session_43127=${secret}`, ...headers },
  method, socket: { localPort: 43127 },
});

test('parallel local instances keep independent port-scoped session cookies', () => {
  assert.doesNotThrow(() => validateRequest(request({ cookie: `ctw_session_43128=other; ctw_session_43127=${secret}` }), secret, false));
  assert.throws(() => validateRequest(request({ cookie: `ctw_session_43128=${secret}` }), secret, false), /会话/);
});

test('cross-site and DNS-rebinding requests are rejected before reading data', () => {
  assert.throws(() => validateRequest(request({ host: 'attacker.example:43127' }), secret, false), /Host/);
  assert.throws(() => validateRequest(request({ origin: 'https://attacker.example' }), secret, false), /来源/);
  assert.throws(() => validateRequest(request({ 'sec-fetch-site': 'cross-site' }), secret, true), /跨站/);
});

test('mutations require a session, exact CSRF token and JSON media type', () => {
  assert.throws(() => validateRequest(request({ cookie: '' }), secret, false), /会话/);
  assert.throws(() => validateRequest(request({}, 'POST'), secret, false), /令牌/);
  assert.throws(() => validateRequest(request({ 'x-workbench-token': secret }, 'POST'), secret, false), /JSON/);
  assert.doesNotThrow(() => validateRequest(request({ 'x-workbench-token': secret, 'content-type': 'application/json', origin: 'http://127.0.0.1:43127' }, 'POST'), secret, false));
});

test('bootstrap only relaxes session authentication, not origin checks', () => {
  assert.doesNotThrow(() => validateRequest(request({ cookie: '' }), secret, true));
  assert.throws(() => validateRequest(request({ cookie: '', origin: 'https://outside.test' }), secret, true), /来源/);
});

test('import paths are restricted to explicit real history roots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctw-security-'));
  try {
    const allowed = join(dir, 'history');
    await mkdir(allowed);
    await writeFile(join(allowed, 'sample.jsonl'), '{}\n');
    await writeFile(join(dir, 'auth.json'), '{}');
    await writeFile(join(allowed, 'not-log.txt'), 'x');
    assert.deepEqual(await validateImportPaths([allowed], [allowed]), [allowed]);
    await assert.rejects(validateImportPaths([join(dir, 'auth.json')], [allowed]), /范围/);
    await assert.rejects(validateImportPaths([join(allowed, 'not-log.txt')], [allowed]), /jsonl/);
    await assert.rejects(validateImportPaths([], [allowed]), /路径/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('structured imports reject forged manual acceptance fields', () => {
  assert.throws(() => assertAllowedKeys({ receiptId: 'r', acceptance: 'accepted' }, ['receiptId']), /acceptance/);
  assert.throws(() => assertAllowedKeys([], []), /对象/);
  assert.doesNotThrow(() => assertAllowedKeys({ receiptId: 'r' }, ['receiptId']));
});
