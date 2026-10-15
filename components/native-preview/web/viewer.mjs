import {App, applyDocumentTheme, applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';
import {OpenAIExtensions, OpenAIFileEntrypointInputSchema} from '@openai/mcp-extensions/app';

const app = new App({name: 'HWPX 미리보기', version: '0.1.8'}, {}, {autoResize: false});
const extensions = new OpenAIExtensions(app);
const $ = id => document.getElementById(id);
let connected, file, session, revision, generation = 0, openVersion = 0, disposed = false, polling = false, observer, openingUri;
const pendingStarts = new Set();
let pages = new Map(), requested = new Set(), queue = [], loading = false;
function notice(text) {$('notice').textContent = text || '';}
async function call(name, args) {
  const result = await app.callServerTool({name, arguments: args});
  if (result.isError) throw new Error(result.structuredContent?.error || result.content?.find(c => c.type === 'text')?.text || '미리보기를 처리하지 못했습니다.');
  return result;
}
function clearPages() {
  observer?.disconnect();
  pages.clear(); requested.clear(); queue = []; $('pages').replaceChildren(); $('jump').replaceChildren();
}
function requestPage(index, version) {
  if (requested.has(index)) return; requested.add(index); queue.push({index, version}); drain();
}
function pageFailed(index, version, sid) {
  if (disposed || version !== generation || sid !== session) return;
  requested.delete(index);
  const figure = pages.get(index);
  if (!figure) return;
  const retry = document.createElement('button');
  retry.className = 'page-placeholder'; retry.type = 'button';
  retry.textContent = '페이지를 표시하지 못했습니다. 눌러서 다시 시도';
  retry.onclick = () => {retry.disabled = true; retry.textContent = '페이지 불러오는 중…'; requestPage(index, version);};
  figure.querySelector('img, .page-placeholder')?.replaceWith(retry);
}
async function drain() {
  if (loading) return; loading = true;
  try {
    while (queue.length && !disposed) {
      const {index, version} = queue.shift(), sid = session, rev = revision;
      if (version !== generation) continue;
      try {
        const result = await call('hwpx_page', {session: sid, revision: rev, index});
        if (version !== generation || sid !== session) continue;
        const p = result._meta?.page;
        if (!p || p.session !== sid || p.revision !== rev || p.index !== index || p.mimeType !== 'image/png') throw new Error('페이지 응답을 확인할 수 없습니다.');
        if (typeof p.data !== 'string' || !p.data.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) throw new Error('PNG 데이터를 확인할 수 없습니다.');
        const image = document.createElement('img'); image.alt = `${index + 1}쪽`;
        image.onerror = () => pageFailed(index, version, sid);
        image.src = `data:image/png;base64,${p.data}`;
        pages.get(index)?.querySelector('.page-placeholder')?.replaceWith(image);
      } catch (e) {
        pageFailed(index, version, sid);
      }
    }
  } finally {loading = false;}
}
function render(state) {
  if (disposed || state.session !== session) return;
  const busy = ['starting', 'queued', 'running'].includes(state.state);
  $('cancel').disabled = !busy; $('refresh').disabled = false; $('apply-fonts').disabled = busy;
  const words = {starting: '준비 중', queued: '처리 대기', running: '렌더링 중', ready: '완료', cancelled: '취소됨', error: '처리 오류', superseded: '갱신 중'};
  $('status').textContent = `${words[state.state] || state.state} · ${state.pages}쪽 · 저장 후 자동 갱신`;
  const reasons = [...(state.unsupported || []), ...(state.errors || [])].map(x => typeof x === 'string' ? x : JSON.stringify(x));
  notice(state.error || (state.sourceStatus === 'unsupported' ? '이 문서의 서식은 아직 지원하지 않습니다.\n' + reasons.join('\n') : reasons.join('\n')));
  if (state.revision == null || (state.revision === revision && state.pages === pages.size)) return;
  revision = state.revision; generation++; clearPages();
  const version = generation;
  observer = new IntersectionObserver(entries => {for (const e of entries) if (e.isIntersecting) requestPage(Number(e.target.dataset.index), version);}, {rootMargin: '800px'});
  for (let i = 0; i < state.pages; i++) {
    const figure = document.createElement('figure'); figure.dataset.index = i; figure.id = `page-${i}`;
    const caption = document.createElement('figcaption'); caption.textContent = `${i + 1} / ${state.pages}`;
    const placeholder = document.createElement('div'); placeholder.className = 'page-placeholder'; placeholder.textContent = '페이지 불러오는 중…';
    figure.append(caption, placeholder); pages.set(i, figure); $('pages').append(figure); observer.observe(figure);
    const option = document.createElement('option'); option.value = i; option.textContent = `${i + 1}쪽`; $('jump').append(option);
  }
  $('jump').disabled = !state.pages;
  if (state.pages) requestPage(0, version);
}
async function poll() {
  if (!session || polling || disposed) return; polling = true;
  const sid = session;
  try {const result = await call('hwpx_status', {session: sid}); if (session === sid) render(result.structuredContent);}
  catch (e) {notice(e.message);}
  finally {polling = false;}
}
async function begin(input) {
  await connected; if (disposed) return;
  const candidate = OpenAIFileEntrypointInputSchema.safeParse(input);
  if (!candidate.success) {notice('앱 안에서 HWPX 파일을 열어 주세요.'); return;}
  if (openingUri === candidate.data.file.resourceUri || (file?.resourceUri === candidate.data.file.resourceUri && session)) return;
  const version = ++openVersion;
  openingUri = candidate.data.file.resourceUri;
  generation++; if (session) await call('hwpx_close', {session}).catch(() => {});
  if (disposed || version !== openVersion) return;
  file = candidate.data.file; session = null; revision = null; clearPages(); $('name').textContent = file.name;
  try {
    const pending = call('hwpx_start', {}); pendingStarts.add(pending);
    let result; try {result = await pending;} finally {pendingStarts.delete(pending);}
    const created = result.structuredContent.session;
    if (disposed || version !== openVersion) {await call('hwpx_close', {session: created}).catch(() => {}); return;}
    session = created; render(result.structuredContent);
  } catch (e) {if (!disposed && version === openVersion) {notice(e.message); $('status').textContent = '연결하지 못했습니다.';}}
  finally {if (version === openVersion) openingUri = null;}
}
function theme(context) {if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);}
app.ontoolinput = ({arguments: args}) => {begin(args).catch(e => notice(e.message));};
app.ontoolresult = result => {if (result.structuredContent?.file) begin({file: result.structuredContent.file}).catch(e => notice(e.message));};
app.onhostcontextchanged = theme;
app.onteardown = async () => {
  disposed = true; openVersion++; clearInterval(timer); clearPages();
  if (session) await call('hwpx_close', {session}).catch(() => {});
  const starts = await Promise.allSettled([...pendingStarts]);
  for (const start of starts) if (start.status === 'fulfilled' && start.value.structuredContent?.session) {
    await call('hwpx_close', {session: start.value.structuredContent.session}).catch(() => {});
  }
  return {};
};
$('refresh').onclick = poll;
$('cancel').onclick = async () => {try {render((await call('hwpx_cancel', {session})).structuredContent);} catch (e) {notice(e.message);}};
$('jump').onchange = () => pages.get(Number($('jump').value))?.scrollIntoView({behavior: 'smooth', block: 'start'});
$('apply-fonts').onclick = async () => {
  try {
    const mapping = JSON.parse($('fonts').value);
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') throw new Error('글꼴 대체는 JSON 객체로 지정해 주세요.');
    $('apply-fonts').disabled = true;
    const result = await call('hwpx_fonts', {session, fontSubstitutions: mapping});
    session = result.structuredContent.session; revision = null; render(result.structuredContent);
  } catch (e) {notice(e.message); $('apply-fonts').disabled = false;}
};
connected = app.connect().then(() => theme(app.getHostContext())).catch(e => {notice('앱 연결을 시작하지 못했습니다. ' + e.message); throw e;});
const timer = setInterval(poll, 2000);
