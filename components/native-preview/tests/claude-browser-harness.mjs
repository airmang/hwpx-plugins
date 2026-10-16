import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

// Serves the Claude profile's ui:// view inside the official AppBridge, with
// the owned document's folder as the only MCP root. Not a native Claude surface.
const [documentPath, readyFile] = process.argv.slice(2);
if (!documentPath || !readyFile) throw new Error('owned fixture and ready path required');
const token = randomBytes(32).toString('base64url');
const client = new Client({name: 'claude-profile-ui-harness', version: '1.0.0'},
  {capabilities: {roots: {}, extensions: {'io.modelcontextprotocol/ui': {mimeTypes: ['text/html;profile=mcp-app']}}}});
client.setRequestHandler(ListRootsRequestSchema, async () => ({roots: [{uri: pathToFileURL(dirname(resolve(documentPath))).href}]}));
await client.connect(new StdioClientTransport({command: process.execPath, args: [resolve('dist/server/index.mjs')], stderr: 'pipe', env: {...process.env, HWPX_PREVIEW_HOST: 'claude'}}));
const open = (await client.listTools()).tools.find(t => t.name === 'hwpx_preview_open');
const resource = await client.readResource({uri: open._meta.ui.resourceUri});
const script = (await build({entryPoints: ['tests/claude-browser-host.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true})).outputFiles[0].text;
const calls = [];
let origin;
const escape = s => s.replace(/[&"<>]/g, c => ({'&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'}[c]));
const server = createServer(async (req, res) => {
  const send = (status, data, type = 'application/json') => {res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(typeof data === 'string' ? data : JSON.stringify(data));};
  if (req.headers.host !== origin.slice(7)) return send(403, {error: 'invalid host'});
  try {
    if (req.method === 'GET' && req.url === `/${token}/`) return send(200, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>HWPX Claude 앱 브리지 검증</title><body data-token="${token}" data-path="${escape(resolve(documentPath))}" style="margin:0;font:14px system-ui"><header style="padding:8px">로컬 검증 화면 · Claude 기본 표시와 구분 <span id="host-state">연결 중</span> <button id="teardown">뷰어 종료</button></header><iframe title="HWPX 미리보기" style="width:100%;height:90vh;border:0"></iframe><script type="module">${script.replace(/<\/script/gi, '<\/script')}</script></body></html>`, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/widget') return send(200, resource.contents[0].text, 'text/html; charset=utf-8');
    if (req.method === 'POST' && req.url === '/rpc' && req.headers['x-test-token'] === token && req.headers.origin === origin) {
      const chunks = []; let size = 0;
      for await (const c of req) {size += c.length; if (size > 65536) throw new Error('too large'); chunks.push(c);}
      const args = JSON.parse(Buffer.concat(chunks));
      if (!/^hwpx_preview_(open|status|page|cancel|close|reopen)$/.test(args.name)) throw new Error('unknown tool');
      const result = await client.callTool(args, undefined, {timeout: 45000});
      calls.push({name: args.name, isError: result.isError === true, pages: result.structuredContent?.pages, state: result.structuredContent?.state?.state ?? result.structuredContent?.state, revision: result.structuredContent?.revision});
      return send(200, result);
    }
    if (req.method === 'GET' && req.url === `/${token}/receipt`) return send(200, {calls, nativeClaudeSurfaceVerified: false});
    return send(404, {error: 'not found'});
  } catch (e) {send(500, {error: e.message});}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(readyFile, JSON.stringify({url: `${origin}/${token}/`, scope: 'Controlled SDK AppBridge test of the Claude profile view, not a native Claude surface'}, null, 2));
console.log('Controlled Claude MCP Apps harness ready');
process.on('SIGTERM', () => client.close().finally(() => server.close()));
process.on('SIGINT', () => client.close().finally(() => server.close()));
