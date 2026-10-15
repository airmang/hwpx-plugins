import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerAppTool, registerAppResource, RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {OpenAIFileEntrypointInputSchema} from '@openai/mcp-extensions';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PreviewSessions} from './sessions.mjs';
import {runtimePath} from './platform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessions = new PreviewSessions(process.env.HWPX_PREVIEW_RUNTIME || runtimePath(root));
const server = new McpServer({name: 'hwpx-file-preview', version: '0.1.9'});
const uri = 'ui://hwpx-file-preview/viewer-v7.html';
// Keep the UI in memory while a running conversation still owns this server;
// a plugin upgrade may remove its previous installation directory.
const viewerHtml = await readFile(resolve(root, 'assets/viewer.html'), 'utf8');
const sessionSchema = z.string().uuid();
const fonts = z.record(z.string().min(1).max(128), z.string().min(1).max(128)).refine(m => Object.keys(m).length <= 32);
const annotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
const reply = data => ({content: [], structuredContent: data});
const guarded = fn => async (args, context) => {
  try {return await fn(args, context._meta);}
  catch (e) {return {isError: true, content: [{type: 'text', text: e.message}], structuredContent: {error: e.message}};}
};

for (const resourceUri of [uri, 'ui://hwpx-file-preview/viewer-v6.html', 'ui://hwpx-file-preview/viewer-v5.html', 'ui://hwpx-file-preview/viewer-v4.html', 'ui://hwpx-file-preview/viewer-v3.html', 'ui://hwpx-file-preview/viewer-v2.html']) {
registerAppResource(server, `HWPX 미리보기 ${resourceUri}`, resourceUri, {}, async () => ({contents: [{
  uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: viewerHtml,
  _meta: {ui: {prefersBorder: false, csp: {connectDomains: [], resourceDomains: []}},
    'openai/widgetDescription': 'HWPX 파일의 로컬 페이지 미리보기',
    'openai/ui': {availableDisplayModes: ['inline', 'fullscreen']}},
}]}));
}
registerAppTool(server, 'hwpx_open', {
  title: 'HWPX 미리보기', description: '앱에서 열린 HWPX 파일의 전용 미리보기를 표시합니다.',
  // Match the official file entrypoint: standard FileInput and default tool
  // visibility. Only the internal render/session operations are app-only.
  inputSchema: OpenAIFileEntrypointInputSchema.shape,
  annotations, _meta: {ui: {resourceUri: uri}, 'openai/ui': {entrypoints: [{type: 'file', extensions: ['.hwpx']}]}}
}, async ({file}) => reply({file, state: 'initializing'}));

const tool = (name, description, schema, fn) => server.registerTool(name, {
  description, inputSchema: schema, annotations, _meta: {ui: {visibility: ['app']}},
}, guarded(fn));
tool('hwpx_start', '앱에서 연 파일을 로컬 렌더러로 미리봅니다.', {fontSubstitutions: fonts.optional()},
  async (args, meta) => reply(await sessions.start(meta, args)));
tool('hwpx_status', '현재 문서의 처리와 변경 감지 상태를 읽습니다.', {session: sessionSchema},
  async ({session}, meta) => reply(await sessions.state(session, meta)));
tool('hwpx_page', '현재 문서의 한 페이지 이미지를 읽습니다.', {session: sessionSchema, revision: z.number().int().positive(), index: z.number().int().min(0).max(255)},
  async ({session, revision, index}, meta) => ({...reply({session, revision, index}), _meta: {page: await sessions.page(session, revision, index, meta)}}));
tool('hwpx_fonts', '사용자가 명시한 글꼴 대체를 적용합니다.', {session: sessionSchema, fontSubstitutions: fonts},
  async ({session, fontSubstitutions}, meta) => reply(await sessions.rerender(session, meta, fontSubstitutions)));
tool('hwpx_cancel', '이 뷰어가 시작한 렌더링을 취소합니다.', {session: sessionSchema},
  async ({session}, meta) => reply(await sessions.cancel(session, meta)));
tool('hwpx_close', '이 뷰어의 임시 미리보기 세션을 닫습니다.', {session: sessionSchema},
  async ({session}, meta) => reply(await sessions.close(session, meta)));

let closing = false;
async function stop() {if (closing) return; closing = true; await sessions.shutdown(); await server.close();}
process.on('SIGTERM', () => stop().finally(() => process.exit(0)));
process.on('SIGINT', () => stop().finally(() => process.exit(0)));
process.stdin.on('end', () => stop().finally(() => process.exit(0)));
await server.connect(new StdioServerTransport());
