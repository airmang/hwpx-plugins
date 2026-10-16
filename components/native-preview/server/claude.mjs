import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerAppTool, registerAppResource, getUiCapability, RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PreviewSessions, checkedHwpx} from './sessions.mjs';
import {ClaudeViews} from './claude-views.mjs';
import {exportPdf, pruneOldPdfs} from './claude-pdf.mjs';
import {runtimePath} from './platform.mjs';
import viewerHtml from '../web/claude-viewer.html';

const fileKey = p => process.platform === 'win32' ? p.toLowerCase() : p;
const fonts = z.record(z.string().min(1).max(128), z.string().min(1).max(128)).refine(m => Object.keys(m).length <= 32);
const viewSchema = z.string().uuid();
const annotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
export const appUri = 'ui://hwpx-native-preview/claude-viewer-v1.html';

export const instructions = [
  'HWPX 페이지 미리보기: 사용자가 .hwpx 문서를 보거나 화면 모양을 확인하고 싶어 하면 hwpx_preview_open에 그 파일의 절대 경로를 넘긴다.',
  'MCP Apps를 표시하는 Claude 화면에서는 대화 안의 미리보기 창에 바로 나타난다. 결과에 url이 있으면(그 화면이 MCP Apps를 표시하지 않는 경우) Claude 앱의 내장 브라우저(Browser pane)에서 연다. 외부 브라우저나 사용자의 Chrome으로 열지 않는다.',
  'url은 한 번만 열 수 있고 몇 분 뒤 만료된다. 다시 보여 줄 때는 hwpx_preview_reopen을 호출한다. 문서를 저장하면 열린 미리보기가 자동으로 갱신된다.',
  '사용자가 휴대폰이나 웹에서 보고 있어 내장 브라우저·미리보기 창을 볼 수 없거나 PDF를 원하면, 편집을 마친 뒤 hwpx_preview_pdf로 모든 쪽을 담은 PDF를 만들고 Claude의 파일 보내기 도구(SendUserFile 등, 가능하면 render 표시)로 그 PDF를 보낸다.',
  '미리보기 엔진이 지원하지 않는 문자·서식이 있으면 페이지가 만들어지지 않는다. 그 사유를 사용자에게 그대로 알린다.',
  '현재 Claude 작업 폴더(roots) 안의 파일만 열 수 있다. 원본 파일은 수정하지 않는다.',
].join('\n');

// Claude authorizes local files through the session's MCP roots (its working
// folders); there is no per-file host grant like Codex's file entrypoint.
export async function rootedHwpx(server, supplied) {
  let value = typeof supplied === 'string' ? supplied.trim() : '';
  if (value.startsWith('file:')) value = fileURLToPath(value);
  if (process.platform === 'win32' && /^[\\/][A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  if (!value || !isAbsolute(value)) throw new Error('미리볼 HWPX 파일의 절대 경로를 지정해 주세요.');
  const path = await checkedHwpx(value);
  if (!server.server.getClientCapabilities()?.roots) throw new Error('이 앱이 작업 폴더(roots)를 제공하지 않아 파일 접근을 확인할 수 없습니다.');
  const {roots} = await server.server.listRoots(undefined, {timeout: 10000});
  for (const root of roots ?? []) {
    if (!root.uri?.startsWith('file:')) continue;
    let folder;
    try {folder = await realpath(fileURLToPath(root.uri));} catch {continue;}
    const rel = relative(fileKey(folder), fileKey(path));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return path;
  }
  throw new Error('현재 Claude 작업 폴더 안의 HWPX 파일만 미리볼 수 있습니다.');
}

function describe(state) {
  const words = {starting: '준비 중', queued: '처리 대기', running: '렌더링 중', ready: '완료', cancelled: '취소됨', error: '처리 오류', superseded: '갱신 중'};
  return `${state.label} · ${words[state.state] ?? state.state} · ${state.pages}쪽`;
}

export async function startClaude(root) {
  const server = new McpServer({name: 'hwpx-native-preview', version: '0.1.10'}, {instructions});
  const sessions = new PreviewSessions(process.env.HWPX_PREVIEW_RUNTIME || runtimePath(root), {authorize: meta => checkedHwpx(meta.path)});
  const views = new ClaudeViews(sessions, viewerHtml);
  pruneOldPdfs().catch(() => {});
  const guarded = fn => async args => {
    try {return await fn(args);}
    catch (e) {return {isError: true, content: [{type: 'text', text: e.message}]};}
  };
  const opened = (result, lead) => ({
    content: [{type: 'text', text: [
      `${lead}: ${result.state ? describe(result.state) : '미리보기'}`,
      `Claude 앱 내장 브라우저에서 이 주소를 여세요: ${result.url}`,
      `주소는 한 번만 열리며 ${Math.round(result.expiresInSeconds / 60)}분 뒤 만료됩니다. 다시 열려면 hwpx_preview_reopen(view: "${result.view}")을 호출하세요.`,
    ].join('\n')}],
    structuredContent: result,
  });

  // Claude's in-app UI standard is MCP Apps: a ui:// resource the host renders
  // in the conversation. Hosts that do not render it (the Code tab while its
  // MCP Apps flag is off) get a single-use URL for the in-app Browser pane.
  const appHtml = await readFile(resolve(root, 'assets/claude-app.html'), 'utf8');
  const rendersApps = () => getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(RESOURCE_MIME_TYPE) === true;
  registerAppResource(server, 'HWPX 미리보기', appUri, {}, async () => ({contents: [{
    uri: appUri, mimeType: RESOURCE_MIME_TYPE, text: appHtml,
    _meta: {ui: {prefersBorder: false, csp: {connectDomains: [], resourceDomains: []}}},
  }]}));
  registerAppTool(server, 'hwpx_preview_open', {
    title: 'HWPX 미리보기 열기',
    description: '작업 폴더 안의 .hwpx 파일을 로컬 렌더러로 페이지 이미지로 렌더링해 Claude 화면에 미리보기로 표시합니다. MCP Apps를 표시하지 않는 화면에서는 내장 브라우저에서 열 일회용 주소를 돌려줍니다. 저장하면 자동 갱신됩니다.',
    inputSchema: {path: z.string().min(1).max(4096).describe('미리볼 .hwpx 파일의 절대 경로'), fontSubstitutions: fonts.optional()},
    annotations, _meta: {ui: {resourceUri: appUri}},
  }, guarded(async ({path, fontSubstitutions}) => {
    const file = await rootedHwpx(server, path);
    if (!rendersApps()) return opened(await views.open(file, {fontSubstitutions}), 'HWPX 미리보기를 준비했습니다');
    const result = await views.open(file, {fontSubstitutions, ticket: false});
    return {content: [{type: 'text', text: `HWPX 미리보기를 대화 안에 표시합니다: ${describe(result.state)}\n내장 브라우저로도 보려면 hwpx_preview_reopen(view: "${result.view}")을 호출하세요.`}], structuredContent: result};
  }));
  const appTool = (name, description, schema, fn) => server.registerTool(name, {description, inputSchema: schema, annotations, _meta: {ui: {visibility: ['app']}}}, guarded(fn));
  appTool('hwpx_preview_page', '미리보기 창이 한 페이지 이미지를 읽습니다.', {view: viewSchema, revision: z.number().int().positive(), index: z.number().int().min(0).max(255)},
    async ({view, revision, index}) => {
      const data = await views.page(view, revision, index);
      // Page bytes travel in _meta for the view only, never as model content.
      return {content: [], structuredContent: {view, revision, index}, _meta: {page: {view, revision, index, mimeType: 'image/png', data: data.toString('base64')}}};
    });
  appTool('hwpx_preview_cancel', '미리보기 창이 진행 중인 렌더링을 취소합니다.', {view: viewSchema},
    async ({view}) => ({content: [], structuredContent: await views.cancel(view)}));
  server.registerTool('hwpx_preview_reopen', {
    title: 'HWPX 미리보기 다시 열기',
    description: '이미 연 HWPX 미리보기를 내장 브라우저에서 다시 열 새 일회용 주소를 발급합니다.',
    inputSchema: {view: viewSchema}, annotations,
  }, guarded(async ({view}) => opened(await views.reopen(view), 'HWPX 미리보기 주소를 다시 발급했습니다')));
  server.registerTool('hwpx_preview_status', {
    title: 'HWPX 미리보기 상태',
    description: '열린 HWPX 미리보기의 처리 상태, 페이지 수, 표시 중인 입력 SHA256을 읽습니다.',
    inputSchema: {view: viewSchema}, annotations,
  }, guarded(async ({view}) => {
    const state = await views.status(view);
    return {content: [{type: 'text', text: `${describe(state)} · revision ${state.revision ?? '-'} · input ${state.inputSha256 ?? '-'}`}], structuredContent: state};
  }));
  server.registerTool('hwpx_preview_pdf', {
    title: 'HWPX 미리보기 PDF 만들기',
    description: '작업 폴더 안의 .hwpx 파일을 현재 저장된 내용 그대로 렌더링해 모든 쪽을 담은 PDF를 임시 폴더에 만들고 그 경로를 돌려줍니다. 원본 문서 폴더에는 쓰지 않습니다. 휴대폰·웹에서 보는 사용자에게 파일 보내기 도구로 전달할 때 씁니다.',
    inputSchema: {path: z.string().min(1).max(4096).describe('PDF로 만들 .hwpx 파일의 절대 경로'), fontSubstitutions: fonts.optional()},
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
  }, guarded(async ({path, fontSubstitutions}) => {
    const result = await exportPdf(sessions, await rootedHwpx(server, path), {fontSubstitutions});
    return {content: [{type: 'text', text: `PDF를 만들었습니다 (${result.pages}쪽, ${Math.round(result.bytes / 1024)} KiB): ${result.pdf}\n사용자가 휴대폰·웹에서 보고 있으면 이 파일을 파일 보내기 도구로 보내세요.`}], structuredContent: result};
  }));
  server.registerTool('hwpx_preview_close', {
    title: 'HWPX 미리보기 닫기',
    description: '열린 HWPX 미리보기와 그 렌더러 작업을 닫습니다.',
    inputSchema: {view: viewSchema}, annotations,
  }, guarded(async ({view}) => ({content: [{type: 'text', text: '미리보기를 닫았습니다.'}], structuredContent: await views.close(view)})));

  let closing = false;
  async function stop() {if (closing) return; closing = true; await views.shutdown(); await sessions.shutdown(); await server.close();}
  process.on('SIGTERM', () => stop().finally(() => process.exit(0)));
  process.on('SIGINT', () => stop().finally(() => process.exit(0)));
  process.stdin.on('end', () => stop().finally(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}
