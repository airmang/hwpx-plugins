import {App, applyDocumentTheme, applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';

// Standard MCP Apps view for Claude hosts that render ui:// resources. The
// file was authorized when the model called hwpx_preview_open (MCP roots);
// this view only follows that view id. No OpenAI extension is used.
const app = new App({name: 'HWPX 미리보기', version: '0.1.10'}, {}, {autoResize: true});
const $ = id => document.getElementById(id);
const words = {starting: '준비 중', queued: '처리 대기', running: '렌더링 중', ready: '완료', cancelled: '취소됨', error: '처리 오류', superseded: '갱신 중'};
let view = null, revision = null, pages = 0, generation = 0, ended = false, polling = false, observer;
let requested = new Set(), queue = [], loading = false;

async function call(name, args) {
  const result = await app.callServerTool({name, arguments: args});
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '미리보기를 처리하지 못했습니다.');
  return result;
}
function notice(text) {$('notice').textContent = text || '';}
function end(text) {ended = true; document.body.dataset.state = 'ended'; $('status').textContent = '미리보기가 끝났습니다.'; $('cancel').disabled = true; notice(text);}
function failed(index, version) {
  if (version !== generation) return;
  requested.delete(index);
  const retry = document.createElement('button');
  retry.className = 'page-placeholder'; retry.type = 'button'; retry.textContent = '페이지를 표시하지 못했습니다. 눌러서 다시 시도';
  retry.onclick = () => {retry.disabled = true; retry.textContent = '페이지 불러오는 중…'; request(index, version);};
  $(`page-${index}`)?.querySelector('img, .page-placeholder')?.replaceWith(retry);
}
function request(index, version) {if (requested.has(index)) return; requested.add(index); queue.push({index, version}); drain();}
async function drain() {
  if (loading) return; loading = true;
  try {
    while (queue.length && !ended) {
      const {index, version} = queue.shift(), rev = revision;
      if (version !== generation) continue;
      try {
        const result = await call('hwpx_preview_page', {view, revision: rev, index});
        const page = result._meta?.page;
        if (version !== generation) continue;
        if (!page || page.revision !== rev || page.index !== index || page.mimeType !== 'image/png' || typeof page.data !== 'string' || !page.data.startsWith('iVBORw0KGgo')) throw new Error('bad page');
        const image = document.createElement('img'); image.alt = `${index + 1}쪽`;
        image.onerror = () => failed(index, version);
        image.src = `data:image/png;base64,${page.data}`;
        $(`page-${index}`)?.querySelector('.page-placeholder')?.replaceWith(image);
      } catch {failed(index, version);}
    }
  } finally {loading = false;}
}
function render(state) {
  const busy = ['starting', 'queued', 'running'].includes(state.state);
  Object.assign(document.body.dataset, {state: state.state, revision: state.revision ?? '', pages: state.pages, inputSha256: state.inputSha256 ?? ''});
  $('name').textContent = state.label;
  $('status').textContent = `${words[state.state] || state.state} · ${state.pages}쪽 · 저장하면 자동 갱신`;
  $('cancel').disabled = !busy;
  const reasons = [...(state.unsupported || []), ...(state.errors || [])].map(x => typeof x === 'string' ? x : JSON.stringify(x));
  notice(state.error || (state.sourceStatus === 'unsupported' ? '이 문서의 서식은 아직 지원하지 않습니다.\n' + reasons.join('\n') : reasons.join('\n')));
  if (state.revision == null || (state.revision === revision && state.pages === pages)) return;
  revision = state.revision; pages = state.pages; generation++;
  const version = generation;
  observer?.disconnect(); requested = new Set(); queue = [];
  observer = new IntersectionObserver(entries => {for (const e of entries) if (e.isIntersecting) request(Number(e.target.dataset.index), version);}, {rootMargin: '800px'});
  const figures = [], options = [];
  for (let i = 0; i < pages; i++) {
    const figure = document.createElement('figure'); figure.id = `page-${i}`; figure.dataset.index = i;
    const caption = document.createElement('figcaption'); caption.textContent = `${i + 1} / ${pages}`;
    const placeholder = document.createElement('div'); placeholder.className = 'page-placeholder'; placeholder.textContent = '페이지 불러오는 중…';
    figure.append(caption, placeholder); figures.push(figure);
    const option = document.createElement('option'); option.value = i; option.textContent = `${i + 1}쪽`; options.push(option);
  }
  $('pages').replaceChildren(...figures); $('jump').replaceChildren(...options); $('jump').disabled = !pages;
  for (const figure of figures) observer.observe(figure);
  if (pages) request(0, version);
}
async function poll() {
  if (!view || polling || ended) return; polling = true;
  try {render((await call('hwpx_preview_status', {view})).structuredContent);}
  catch (e) {end(e.message);}
  finally {polling = false;}
}
function theme(context) {if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);}
app.ontoolresult = result => {
  if (result.isError) {end(result.content?.find(c => c.type === 'text')?.text || '미리보기를 열지 못했습니다.'); return;}
  const opened = result.structuredContent;
  if (!opened?.view || opened.view === view) return;
  view = opened.view; ended = false;
  if (opened.state) render(opened.state);
  poll();
};
app.onhostcontextchanged = theme;
app.onteardown = async () => {
  ended = true; clearInterval(timer); observer?.disconnect();
  if (view) await call('hwpx_preview_close', {view}).catch(() => {});
  return {};
};
$('cancel').onclick = async () => {try {await call('hwpx_preview_cancel', {view}); poll();} catch (e) {notice(e.message);}};
$('jump').onchange = () => $(`page-${$('jump').value}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
app.connect().then(() => theme(app.getHostContext())).catch(e => notice('앱 연결을 시작하지 못했습니다. ' + e.message));
const timer = setInterval(poll, 2000);
