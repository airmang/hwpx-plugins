import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const [documentPath, readyFile, mode] = process.argv.slice(2);
const strictCsp = ['--strict-csp', '--strict-csp-bad-page-once'].includes(mode);
let badPagePending = mode === '--strict-csp-bad-page-once';
if (!documentPath || !readyFile) throw new Error('owned fixture and ready path required');
const token = randomBytes(32).toString('base64url');
const client = new Client({name: 'controlled-ui-harness', version: '1.0.0'});
const transport = new StdioClientTransport({command: process.execPath, args: [resolve('dist/server/index.mjs')], stderr: 'pipe', env: {...process.env}});
await client.connect(transport);
const resource = await client.readResource({uri: 'ui://hwpx-file-preview/viewer-v2.html'});
const script = (await build({entryPoints: ['tests/browser-host.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true})).outputFiles[0].text;
const calls = [];
let origin;
const server = createServer(async (req, res) => {
  const send = (status, data, type = 'application/json') => {res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(typeof data === 'string' ? data : JSON.stringify(data));};
  if (req.headers.host !== origin.slice(7)) return send(403, {error: 'invalid host'});
  try {
    if (req.method === 'GET' && req.url === `/${token}/`) return send(200, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>HWPX 앱 브리지 검증</title><body data-token="${token}" style="margin:0;font:14px system-ui"><header style="padding:8px">로컬 검증 화면 · ChatGPT 파일 클릭 검증과 구분 <span id="host-state">연결 중</span> <button id="teardown">뷰어 종료</button></header><iframe title="HWPX 파일 뷰어" style="width:100%;height:90vh;border:0"></iframe><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/widget') {
      if (strictCsp) res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'");
      return send(200, resource.contents[0].text, 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && req.url === '/rpc' && req.headers['x-test-token'] === token && req.headers.origin === origin) {
      const chunks = []; let size = 0;
      for await (const c of req) {size += c.length; if (size > 65536) throw new Error('too large'); chunks.push(c);}
      const args = JSON.parse(Buffer.concat(chunks));
      if (!/^hwpx_(open|start|status|page|cancel|fonts|close)$/.test(args.name)) throw new Error('unknown tool');
      const result = await client.callTool({...args, _meta: {'openai/resource': {path: resolve(documentPath)}}}, undefined, {timeout: 45000});
      calls.push({name: args.name, isError: result.isError === true, pages: result.structuredContent?.pages, state: result.structuredContent?.state});
      if (badPagePending && args.name === 'hwpx_page' && result._meta?.page) {
        // Exercise image decode failure after an otherwise valid MCP response.
        result._meta.page.data = Buffer.from(result._meta.page.data, 'base64').subarray(0, 8).toString('base64');
        badPagePending = false;
      }
      return send(200, result);
    }
    if (req.method === 'GET' && req.url === `/${token}/receipt`) return send(200, {calls, actualDesktopFileClickVerified: false});
    return send(404, {error: 'not found'});
  } catch (e) {send(500, {error: e.message});}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(readyFile, JSON.stringify({url: `${origin}/${token}/`, strictCsp, scope: 'Controlled SDK AppBridge test, not native ChatGPT entrypoint'}, null, 2));
console.log('Controlled MCP Apps harness ready');
process.on('SIGTERM', () => client.close().finally(() => server.close()));
process.on('SIGINT', () => client.close().finally(() => server.close()));
