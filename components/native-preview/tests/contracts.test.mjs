import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {authorizedFile, parseReady, publicState, PreviewSessions} from '../server/sessions.mjs';

test('renderer receipt permits only the owned loopback endpoint', () => {
  const token = 'x'.repeat(43);
  assert.deepEqual(parseReady(JSON.stringify({port: 1234, url: `http://127.0.0.1:1234/#${token}`})), {origin: 'http://127.0.0.1:1234', token});
  for (const url of [`https://127.0.0.1:1234/#${token}`, `http://example.com:1234/#${token}`, `http://user@127.0.0.1:1234/#${token}`, `http://127.0.0.1:1234/evil#${token}`, `http://127.0.0.1:1234/?x#${token}`]) {
    assert.throws(() => parseReady(JSON.stringify({port: 1234, url})));
  }
});
test('no raw path can be supplied instead of host resource authorization', async () => {
  await assert.rejects(authorizedFile({}));
  await assert.rejects(authorizedFile({path: 'D:\\secret.hwpx'}));
  await assert.rejects(authorizedFile({'openai/resource': {path: '../secret.hwpx'}}));
});
test('file and session access stay bound to the opened document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwpx-plugin-contract-'));
  const a = join(root, '한글 😀.hwpx'), b = join(root, '다른.hwpx'), txt = join(root, 'invalid.txt');
  await Promise.all([writeFile(a, 'a'), writeFile(b, 'b'), writeFile(txt, 't')]);
  const sessions = new PreviewSessions(join(root, 'not-started.exe'));
  try {
    const meta = {'openai/resource': {path: a}};
    const path = await authorizedFile(meta);
    sessions.sessions.set('test', {path, touched: 0});
    assert.equal((await sessions.lookup('test', meta)).path, path);
    if (process.platform === 'win32') {
      const remoteMeta = {'openai/resource': {path: '/' + a.replaceAll('\\', '/')}};
      assert.equal(await authorizedFile(remoteMeta), path);
      assert.equal((await sessions.lookup('test', remoteMeta)).path, path);
      await assert.rejects(sessions.lookup('test', {'openai/resource': {path: '/' + b.replaceAll('\\', '/')}}));
    }
    await assert.rejects(sessions.lookup('test', {'openai/resource': {path: b}}));
    await assert.rejects(authorizedFile({'openai/resource': {path: txt}}));
    await assert.rejects(sessions.lookup('missing', meta));
  } finally {
    sessions.sessions.clear(); await sessions.shutdown();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, {recursive: true, force: true});
  }
});
test('a failed new save preserves only the last accepted pages', () => {
  const state = publicState({latest: {state: 'error', label: 'x', result: {error: 'incomplete save'}}, displayed: 1,
    displayedJob: {inputSha256: 'prior', result: {status: 'supported', pages: 3, qualityValidated: false}}}, 'session');
  assert.equal(state.pages, 3); assert.equal(state.error, 'incomplete save'); assert.equal(state.revision, 1);
  assert.equal(state.qualityValidated, false); assert.equal(state.inputSha256, 'prior');
  assert.equal('path' in state, false);
});
