import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';

test('built stdio server advertises a real .hwpx file viewer and rejects unauthorized render', async () => {
  const client = new Client({name: 'hwpx-plugin-probe', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.env.HWPX_TEST_SERVER_NODE || process.execPath, args: [resolve(process.env.HWPX_TEST_SERVER || 'dist/server/index.mjs')], stderr: 'pipe', env: {...process.env}});
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const open = tools.tools.find(t => t.name === 'hwpx_open');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{type: 'file', extensions: ['.hwpx']}]);
    assert.equal(open._meta.ui.resourceUri, 'ui://hwpx-file-preview/viewer-v6.html');
    assert.equal(open._meta.ui.visibility, undefined);
    for (const internal of tools.tools.filter(t => t.name !== 'hwpx_open')) {
      assert.deepEqual(internal._meta.ui.visibility, ['app']);
    }
    const resource = await client.readResource({uri: open._meta.ui.resourceUri});
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /페이지 이동/);
    assert.match(resource.contents[0].text, /HWPX 미리보기/);
    new Script(resource.contents[0].text.match(/<script>([\s\S]*)<\/script>/)[1]);
    for (const uri of ['ui://hwpx-file-preview/viewer-v5.html', 'ui://hwpx-file-preview/viewer-v2.html', 'ui://hwpx-file-preview/viewer-v3.html', 'ui://hwpx-file-preview/viewer-v4.html']) {
      assert.equal((await client.readResource({uri})).contents[0].text, resource.contents[0].text);
    }
    const initial = await client.callTool({name: 'hwpx_open', arguments: {file: {name: '한글.hwpx', resourceUri: 'host-resource://opaque'}}});
    assert.equal(initial.structuredContent.file.resourceUri, 'host-resource://opaque');
    const rejected = await client.callTool({name: 'hwpx_start', arguments: {}});
    assert.equal(rejected.isError, true);
    if (process.env.HWPX_TEST_FILE) {
      const path = resolve(process.env.HWPX_TEST_FILE), original = await readFile(path), before = createHash('sha256').update(original).digest('hex');
      const meta = {'openai/resource': {path: process.env.HWPX_TEST_URI_STYLE_PATH === '1' ? '/' + path.replaceAll('\\', '/') : path}};
      const attempts = await Promise.all([0, 1, 2].map(() => client.callTool({name: 'hwpx_start', arguments: {fontSubstitutions: JSON.parse(process.env.HWPX_TEST_FONTS || '{}')}, _meta: meta}, undefined, {timeout: 40000})));
      const [started, ...extra] = attempts;
      assert.equal(started.isError, undefined, JSON.stringify(started));
      const session = started.structuredContent.session;
      // A retried/recreated native view must reuse this file's renderer without
      // exhausting the two-worker limit, and keep independently closable leases.
      assert.ok(extra.every(r => !r.isError), JSON.stringify(extra));
      const extraSessions = extra.map(r => r.structuredContent.session);
      assert.equal(new Set([session, ...extraSessions]).size, 3);
      await client.callTool({name: 'hwpx_close', arguments: {session: extraSessions[0]}, _meta: meta});
      assert.equal((await client.callTool({name: 'hwpx_status', arguments: {session: extraSessions[1]}, _meta: meta})).isError, undefined);
      await client.callTool({name: 'hwpx_close', arguments: {session: extraSessions[1]}, _meta: meta});
      let state, deadline = Date.now() + 140000;
      while (Date.now() < deadline) {
        const r = await client.callTool({name: 'hwpx_status', arguments: {session}, _meta: meta});
        state = r.structuredContent;
        if (state?.state === 'ready' || state?.state === 'error') break;
        await new Promise(r => setTimeout(r, 250));
      }
      assert.equal(state.state, 'ready', JSON.stringify(state));
      assert.equal(state.sourceStatus, 'supported', JSON.stringify(state));
      assert.ok(state.pages > 0);
      const page = await client.callTool({name: 'hwpx_page', arguments: {session, revision: state.revision, index: 0}, _meta: meta});
      assert.equal(page.isError, undefined, JSON.stringify(page.structuredContent));
      assert.equal(page.content.length, 0); assert.equal(page._meta.page.mimeType, 'image/png');
      const bytes = Buffer.from(page._meta.page.data, 'base64'); assert.ok(bytes.length > 1000);
      if (process.env.HWPX_TEST_EXPECTED_PNG) assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(await readFile(process.env.HWPX_TEST_EXPECTED_PNG)).digest('hex'));
      const pageHashes = [{index: 0, sha256: createHash('sha256').update(bytes).digest('hex')}];
      if (process.env.HWPX_TEST_EXPECTED_ROOT) {
        for (let index = 0; index < state.pages; index++) {
          const p = index === 0 ? page : await client.callTool({name: 'hwpx_page', arguments: {session, revision: state.revision, index}, _meta: meta});
          assert.equal(p.isError, undefined);
          const hash = createHash('sha256').update(Buffer.from(p._meta.page.data, 'base64')).digest('hex');
          assert.equal(hash, createHash('sha256').update(await readFile(resolve(process.env.HWPX_TEST_EXPECTED_ROOT, `p${index}.png`))).digest('hex'));
          if (index) pageHashes.push({index, sha256: hash});
        }
      }
      assert.equal(state.inputSha256, before);
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
      const wrong = await client.callTool({name: 'hwpx_status', arguments: {session}}); assert.equal(wrong.isError, true);
      if (process.env.HWPX_TEST_WATCH === 'owned-copy') {
        assert.ok(path.includes('app-integration-001'), 'writes are restricted to this integration run\'s owned copy');
        const waitFor = async predicate => {
          const end = Date.now() + 30000;
          while (Date.now() < end) {
            const r = await client.callTool({name: 'hwpx_status', arguments: {session}, _meta: meta});
            if (predicate(r.structuredContent)) return r.structuredContent;
            await new Promise(r => setTimeout(r, 200));
          }
          throw new Error('watch state did not arrive');
        };
        try {
          await writeFile(path, Buffer.concat([original, Buffer.from('\nowned-save-002')]));
          const changed = await waitFor(s => s.state === 'ready' && s.revision > state.revision);
          await writeFile(path, 'partial');
          const partial = await waitFor(s => s.state === 'error');
          assert.equal(partial.revision, changed.revision); assert.equal(partial.pages, changed.pages);
          await writeFile(path, original);
          const repaired = await waitFor(s => s.state === 'ready' && s.revision > changed.revision);
          assert.equal(repaired.inputSha256, before);
        } finally {await writeFile(path, original);}
      }
      const closed = await client.callTool({name: 'hwpx_close', arguments: {session}, _meta: meta}); assert.equal(closed.structuredContent.closed, true);
      if (process.env.HWPX_TEST_REPORT) await writeFile(process.env.HWPX_TEST_REPORT, JSON.stringify({status: 'passed', protocol: 'real MCP stdio', fileEntrypoint: '.hwpx',
        pages: state.pages, pageHashes, inputSha256: before, sourceUnchanged: createHash('sha256').update(await readFile(path)).digest('hex') === before,
        unauthorizedCallRejected: true, closePassed: true, watchChecks: process.env.HWPX_TEST_WATCH === 'owned-copy',
        hostPathStyle: process.env.HWPX_TEST_URI_STYLE_PATH === '1' ? 'uri-style-windows-drive' : 'native-absolute',
        sameFileThreeIndependentLeasesPassed: true, actualDesktopFileClickVerified: false}, null, 2));
    }
  } finally {await client.close();}
});

test('running viewer keeps its UI after an installation asset is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwpx-plugin-upgrade-test-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await mkdir(join(root, 'server')); await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'server/index.mjs'), await readFile('dist/server/index.mjs'));
  await writeFile(join(root, 'assets/viewer.html'), await readFile('dist/assets/viewer.html'));
  const client = new Client({name: 'hwpx-upgrade-probe', version: '1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command: process.execPath, args: [join(root, 'server/index.mjs')], stderr: 'pipe'}));
    const open = (await client.listTools()).tools.find(t => t.name === 'hwpx_open');
    const before = await client.readResource({uri: open._meta.ui.resourceUri});
    await rm(join(root, 'assets/viewer.html'));
    const after = await client.readResource({uri: open._meta.ui.resourceUri});
    assert.equal(after.contents[0].text, before.contents[0].text);
  } finally {
    await client.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, {recursive: true, force: true});
  }
});
