import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {readFile, writeFile, mkdtemp, rm, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';
import {pathToFileURL} from 'node:url';
import {ClaudeViews} from '../server/claude-views.mjs';
import {pagesToPdf, pngImage} from '../server/pdf.mjs';
import {deflateSync} from 'node:zlib';

const sha = data => createHash('sha256').update(data).digest('hex');
const viewer = '<!doctype html><title>t</title><body><script>window.ok=1</script></body>';

function http(url, {method = 'GET', headers = {}} = {}) {
  return new Promise((done, fail) => {
    const req = request(url, {method, headers}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => done({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', fail); req.end();
  });
}

class FakeSessions {
  constructor() {this.sessions = new Map(); this.released = [];}
  async start({path}) {const session = `s${this.sessions.size}`; this.sessions.set(session, path); return {session, state: 'ready', pages: 1, revision: 1, label: basename(path)};}
  async lookup(session, {path}) {if (this.sessions.get(session) !== path) throw new Error('gone'); return {};}
  async state(session, meta) {await this.lookup(session, meta); return {session, state: 'ready', pages: 1, revision: 1, label: 'a.hwpx', inputSha256: 'f'.repeat(64)};}
  async pageBytes(session, revision, index, meta) {await this.lookup(session, meta); if (revision !== 1 || index !== 0) throw new Error('stale'); return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);}
  async cancel(session, meta) {await this.lookup(session, meta);}
  async release(session) {this.sessions.delete(session); this.released.push(session);}
}

test('a ticket is single-use, host-bound and exchanged for a view-scoped cookie', async () => {
  const sessions = new FakeSessions(), views = new ClaudeViews(sessions, viewer);
  try {
    const opened = await views.open('/docs/a.hwpx');
    assert.equal('session' in JSON.parse(JSON.stringify(opened.state)), false);
    const url = new URL(opened.url);
    assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /^\/open\/[A-Za-z0-9_-]{43}$/);
    const spoofed = await http(opened.url, {headers: {Host: `localhost:${url.port}`}});
    assert.equal(spoofed.status, 403);
    const first = await http(opened.url);
    assert.equal(first.status, 303); assert.equal(first.headers.location, `/v/${opened.view}/`);
    const cookie = first.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, new RegExp(`Path=/v/${opened.view}/`));
    assert.equal((await http(opened.url)).status, 410);
    const base = `${url.origin}/v/${opened.view}/`, auth = {Cookie: cookie.split(';')[0]};
    assert.equal((await http(base)).status, 403);
    const page = await http(base, {headers: auth});
    assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /script-src 'sha256-/);
    assert.equal(page.body.toString(), viewer);
    const status = JSON.parse((await http(base + 'api/status', {headers: auth})).body);
    assert.equal(status.pages, 1); assert.equal('session' in status, false); assert.equal('path' in status, false);
    const png = await http(base + 'api/pages/1/0.png', {headers: auth});
    assert.equal(png.status, 200); assert.equal(png.headers['content-type'], 'image/png');
    assert.equal((await http(base + 'api/pages/9/0.png', {headers: auth})).status, 409);
    assert.equal((await http(base + 'api/cancel', {method: 'POST', headers: auth})).status, 403);
    assert.equal((await http(base + 'api/cancel', {method: 'POST', headers: {...auth, Origin: url.origin}})).status, 200);
    const other = await views.open('/docs/b.hwpx');
    assert.equal((await http(`${url.origin}/v/${other.view}/api/status`, {headers: auth})).status, 403);
    const again = await views.reopen(opened.view);
    assert.notEqual(again.url, opened.url); assert.equal((await http(again.url)).status, 303);
    await views.close(opened.view);
    assert.deepEqual(sessions.released, ['s0']);
    assert.equal((await http(base + 'api/status', {headers: auth})).status, 403);
    await assert.rejects(views.reopen(opened.view));
  } finally {await views.shutdown();}
});

test('an expired ticket and an ended lease do not open a view', async () => {
  const sessions = new FakeSessions(), views = new ClaudeViews(sessions, viewer, {ticketMs: 1});
  try {
    const opened = await views.open('/docs/a.hwpx');
    await new Promise(r => setTimeout(r, 10));
    assert.equal((await http(opened.url)).status, 410);
    sessions.sessions.clear();
    await assert.rejects(views.status(opened.view));
  } finally {await views.shutdown();}
});

test('Claude profile authorizes files through MCP roots and serves real pages to the in-app browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwpx-claude-profile-'));
  const outside = await mkdtemp(join(tmpdir(), 'hwpx-claude-outside-'));
  const client = new Client({name: 'claude-profile-probe', version: '1.0.0'}, {capabilities: {roots: {}}});
  client.setRequestHandler(ListRootsRequestSchema, async () => ({roots: [{uri: pathToFileURL(root).href, name: 'workspace'}]}));
  const installed = process.env.HWPX_TEST_MCP_CONFIG
    ? JSON.parse(await readFile(process.env.HWPX_TEST_MCP_CONFIG, 'utf8')).mcpServers.hwpx_native_preview
    : {command: process.env.HWPX_TEST_SERVER_NODE || process.execPath, args: [resolve(process.env.HWPX_TEST_SERVER || 'dist/server/index.mjs')], env: {HWPX_PREVIEW_HOST: 'claude'}};
  await client.connect(new StdioClientTransport({...installed, stderr: 'pipe', env: {...process.env, ...installed.env}}));
  try {
    assert.match(client.getInstructions(), /내장 브라우저/);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['hwpx_preview_cancel', 'hwpx_preview_close', 'hwpx_preview_open', 'hwpx_preview_page', 'hwpx_preview_pdf', 'hwpx_preview_reopen', 'hwpx_preview_status']);
    assert.ok(tools.every(t => t.annotations.destructiveHint === false && (t.name === 'hwpx_preview_pdf' || t.annotations.readOnlyHint === true) && !t._meta?.['openai/ui'] && !t._meta?.['openai/outputTemplate']));
    const open = tools.find(t => t.name === 'hwpx_preview_open');
    assert.equal(open._meta.ui.resourceUri, 'ui://hwpx-native-preview/claude-viewer-v1.html');
    for (const name of ['hwpx_preview_page', 'hwpx_preview_cancel']) assert.deepEqual(tools.find(t => t.name === name)._meta.ui.visibility, ['app']);
    const resource = (await client.readResource({uri: open._meta.ui.resourceUri})).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.doesNotMatch(resource.text, /openai/i);
    new Script(resource.text.match(/<script>([\s\S]*)<\/script>/)[1]);
    await writeFile(join(outside, 'secret.hwpx'), 'x');
    await writeFile(join(root, 'note.txt'), 'x');
    for (const path of [join(outside, 'secret.hwpx'), 'relative.hwpx', join(root, 'note.txt'), join(root, 'missing.hwpx')]) {
      const rejected = await client.callTool({name: 'hwpx_preview_open', arguments: {path}});
      assert.equal(rejected.isError, true, path);
    }
    if (process.env.HWPX_TEST_FILE) {
      const path = join(root, '미리보기 시험.hwpx');
      await copyFile(resolve(process.env.HWPX_TEST_FILE), path);
      const original = await readFile(path), before = sha(original);
      const opened = await client.callTool({name: 'hwpx_preview_open', arguments: {path}}, undefined, {timeout: 60000});
      assert.equal(opened.isError, undefined, JSON.stringify(opened.content));
      const {view, url} = opened.structuredContent;
      assert.match(opened.content[0].text, /내장 브라우저/);
      const exchanged = await http(url);
      assert.equal(exchanged.status, 303);
      const base = new URL(exchanged.headers.location, url).href, auth = {Cookie: exchanged.headers['set-cookie'][0].split(';')[0]};
      const waitFor = async predicate => {
        const end = Date.now() + 140000;
        while (Date.now() < end) {
          const state = JSON.parse((await http(base + 'api/status', {headers: auth})).body);
          if (predicate(state)) return state;
          await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('preview state did not arrive');
      };
      const state = await waitFor(s => s.state === 'ready' || s.state === 'error');
      assert.equal(state.state, 'ready', JSON.stringify(state)); assert.equal(state.sourceStatus, 'supported');
      assert.equal(state.inputSha256, before); assert.ok(state.pages > 0);
      const png = await http(base + `api/pages/${state.revision}/0.png`, {headers: auth});
      assert.equal(png.status, 200); assert.ok(png.body.length > 1000);
      if (process.env.HWPX_TEST_EXPECTED_PNG) assert.equal(sha(png.body), sha(await readFile(process.env.HWPX_TEST_EXPECTED_PNG)));
      const status = await client.callTool({name: 'hwpx_preview_status', arguments: {view}});
      assert.equal(status.structuredContent.inputSha256, before);
      await writeFile(path, Buffer.concat([original, Buffer.from('\nclaude-save-001')]));
      const changed = await waitFor(s => s.state === 'ready' && s.revision > state.revision);
      await writeFile(path, 'partial');
      const partial = await waitFor(s => s.state === 'error');
      assert.equal(partial.revision, changed.revision); assert.equal(partial.pages, changed.pages);
      await writeFile(path, original);
      const repaired = await waitFor(s => s.state === 'ready' && s.revision > changed.revision);
      assert.equal(repaired.inputSha256, before);
      assert.equal((await client.callTool({name: 'hwpx_preview_close', arguments: {view}})).structuredContent.closed, true);
      assert.equal((await http(base + 'api/status', {headers: auth})).status, 403);
      if (process.env.HWPX_TEST_REPORT) await writeFile(process.env.HWPX_TEST_REPORT, JSON.stringify({
        status: 'passed', protocol: 'real MCP stdio + loopback viewer', host: 'claude', rootsEnforced: true,
        pages: state.pages, page0Sha256: sha(png.body), inputSha256: before, saveRefresh: true, partialSaveKeepsLastPages: true,
        singleUseTicket: true, actualClaudeAppVerified: false,
      }, null, 2));
    }
  } finally {
    await client.close();
    for (const dir of [root, outside]) {assert.equal(dirname(resolve(dir)), resolve(tmpdir())); await rm(dir, {recursive: true, force: true});}
  }
});

test('a Claude host that renders MCP Apps gets the in-conversation view instead of a Browser pane URL', {skip: !process.env.HWPX_TEST_FILE}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwpx-claude-apps-'));
  const client = new Client({name: 'claude-apps-probe', version: '1.0.0'},
    {capabilities: {roots: {}, extensions: {'io.modelcontextprotocol/ui': {mimeTypes: ['text/html;profile=mcp-app']}}}});
  client.setRequestHandler(ListRootsRequestSchema, async () => ({roots: [{uri: pathToFileURL(root).href}]}));
  const installed = process.env.HWPX_TEST_MCP_CONFIG
    ? JSON.parse(await readFile(process.env.HWPX_TEST_MCP_CONFIG, 'utf8')).mcpServers.hwpx_native_preview
    : {command: process.env.HWPX_TEST_SERVER_NODE || process.execPath, args: [resolve(process.env.HWPX_TEST_SERVER || 'dist/server/index.mjs')], env: {HWPX_PREVIEW_HOST: 'claude'}};
  await client.connect(new StdioClientTransport({...installed, stderr: 'pipe', env: {...process.env, ...installed.env}}));
  try {
    const path = join(root, '앱 시험.hwpx');
    await copyFile(resolve(process.env.HWPX_TEST_FILE), path);
    const before = sha(await readFile(path));
    const opened = await client.callTool({name: 'hwpx_preview_open', arguments: {path}}, undefined, {timeout: 60000});
    assert.equal(opened.isError, undefined, JSON.stringify(opened.content));
    assert.equal(opened.structuredContent.url, undefined);
    assert.match(opened.content[0].text, /대화 안에/);
    const {view} = opened.structuredContent;
    let state, end = Date.now() + 140000;
    while (Date.now() < end) {
      state = (await client.callTool({name: 'hwpx_preview_status', arguments: {view}})).structuredContent;
      if (state.state === 'ready' || state.state === 'error') break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(state.state, 'ready', JSON.stringify(state)); assert.equal(state.inputSha256, before);
    const page = await client.callTool({name: 'hwpx_preview_page', arguments: {view, revision: state.revision, index: 0}});
    assert.equal(page.isError, undefined); assert.equal(page.content.length, 0);
    const png = Buffer.from(page._meta.page.data, 'base64');
    assert.ok(png.length > 1000);
    if (process.env.HWPX_TEST_EXPECTED_PNG_SHA256) assert.equal(sha(png), process.env.HWPX_TEST_EXPECTED_PNG_SHA256);
    assert.equal((await client.callTool({name: 'hwpx_preview_page', arguments: {view, revision: state.revision + 5, index: 0}})).isError, true);
    const reopened = await client.callTool({name: 'hwpx_preview_reopen', arguments: {view}});
    assert.match(reopened.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/open\//);
    assert.equal((await client.callTool({name: 'hwpx_preview_close', arguments: {view}})).structuredContent.closed, true);
  } finally {
    await client.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, {recursive: true, force: true});
  }
});

function png(width, height, colorType = 2) {
  const chunk = (type, body) => {const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b;};
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  const row = 1 + width * (colorType === 2 ? 3 : 1), raw = Buffer.alloc(row * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * row] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('page PNGs become a PDF whose images keep the page size at the render resolution', () => {
  const pdf = pagesToPdf([png(2480, 3508), png(2480, 3508, 0)], {title: '한글 문서.hwpx'}).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4')); assert.ok(pdf.trimEnd().endsWith('%%EOF'));
  assert.match(pdf, /\/Type \/Pages \/Count 2/);
  assert.equal((pdf.match(/\/MediaBox \[0 0 595\.200 841\.920\]/g) ?? []).length, 2);
  assert.match(pdf, /\/DeviceRGB/); assert.match(pdf, /\/DeviceGray/); assert.match(pdf, /\/Predictor 15/);
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.ok(pdf.startsWith('xref', xref));
  assert.throws(() => pngImage(png(4, 4, 6)));
  assert.throws(() => pngImage(Buffer.from('not a png')));
  assert.throws(() => pagesToPdf([]));
});

test('hwpx_preview_pdf exports the bytes on disk and refuses a document the renderer does not support', {skip: !process.env.HWPX_TEST_FILE}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwpx-claude-pdf-'));
  const client = new Client({name: 'claude-pdf-probe', version: '1.0.0'}, {capabilities: {roots: {}}});
  client.setRequestHandler(ListRootsRequestSchema, async () => ({roots: [{uri: pathToFileURL(root).href}]}));
  const installed = process.env.HWPX_TEST_MCP_CONFIG
    ? JSON.parse(await readFile(process.env.HWPX_TEST_MCP_CONFIG, 'utf8')).mcpServers.hwpx_native_preview
    : {command: process.env.HWPX_TEST_SERVER_NODE || process.execPath, args: [resolve(process.env.HWPX_TEST_SERVER || 'dist/server/index.mjs')], env: {HWPX_PREVIEW_HOST: 'claude'}};
  await client.connect(new StdioClientTransport({...installed, stderr: 'pipe', env: {...process.env, ...installed.env}}));
  try {
    const path = join(root, 'PDF 시험.hwpx');
    await copyFile(resolve(process.env.HWPX_TEST_FILE), path);
    const before = sha(await readFile(path));
    const made = await client.callTool({name: 'hwpx_preview_pdf', arguments: {path}}, undefined, {timeout: 200000});
    assert.equal(made.isError, undefined, JSON.stringify(made.content));
    const {pdf, pages, inputSha256} = made.structuredContent;
    assert.equal(inputSha256, before); assert.ok(pages > 0);
    assert.equal(dirname(dirname(pdf)), join(tmpdir(), 'hwpx-preview-pdf'));
    const bytes = await readFile(pdf);
    assert.ok(bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-'));
    assert.ok(bytes.toString('latin1').includes(`/Type /Pages /Count ${pages} `));
    assert.equal(sha(await readFile(path)), before);
    if (process.env.HWPX_TEST_PDF_COPY) await copyFile(pdf, process.env.HWPX_TEST_PDF_COPY);
    await rm(dirname(pdf), {recursive: true, force: true});
    if (process.env.HWPX_TEST_UNSUPPORTED_FILE) {
      const bad = join(root, '지원안됨.hwpx');
      await copyFile(resolve(process.env.HWPX_TEST_UNSUPPORTED_FILE), bad);
      const refused = await client.callTool({name: 'hwpx_preview_pdf', arguments: {path: bad}}, undefined, {timeout: 200000});
      assert.equal(refused.isError, true); assert.match(refused.content[0].text, /PDF를 만들지 않았습니다/);
    }
  } finally {
    await client.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, {recursive: true, force: true});
  }
});
