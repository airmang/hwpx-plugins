import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, extname, join} from 'node:path';
import {pagesToPdf} from './pdf.mjs';

// PDF copies of the current pages, for Claude surfaces that cannot show the
// Browser pane or an MCP App (the mobile and web clients of a desktop session).
// Files go to an owned temp folder, never next to the user's document.
export const pdfRoot = join(tmpdir(), 'hwpx-preview-pdf');
const delay = ms => new Promise(r => setTimeout(r, ms));
const sha = data => createHash('sha256').update(data).digest('hex');

export async function pruneOldPdfs(maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries;
  try {entries = await readdir(pdfRoot, {withFileTypes: true});} catch {return;}
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const folder = join(pdfRoot, entry.name);
    try {if (Date.now() - (await stat(folder)).mtimeMs > maxAgeMs) await rm(folder, {recursive: true, force: true});} catch {}
  }
}

export async function exportPdf(sessions, path, {fontSubstitutions, timeoutMs = 180000, dpi = 300} = {}) {
  const meta = {path};
  let state = await sessions.start(meta, {fontSubstitutions, dpi});
  const session = state.session;
  try {
    const end = Date.now() + timeoutMs;
    for (;;) {
      // Export only pages rendered from the bytes on disk now, never a
      // previously accepted revision kept while a newer save failed.
      const current = sha(await readFile(path));
      if (state.state === 'ready' && state.inputSha256 === current) break;
      if (state.state === 'error' && state.revision !== null && state.inputSha256 !== current || state.state === 'cancelled' || state.state === 'ready' && state.sourceStatus !== 'supported') {
        const reasons = [...(state.unsupported ?? []), ...(state.errors ?? [])].map(x => typeof x === 'string' ? x : JSON.stringify(x));
        throw new Error(['현재 문서를 미리보기로 렌더링하지 못해 PDF를 만들지 않았습니다.', state.error, ...reasons].filter(Boolean).join('\n'));
      }
      if (state.state === 'error' && state.revision === null) throw new Error(state.error || '문서를 렌더링하지 못했습니다.');
      if (Date.now() > end) throw new Error('렌더링 시간이 한도를 넘어 PDF를 만들지 않았습니다.');
      await delay(300);
      state = await sessions.state(session, meta);
    }
    if (state.sourceStatus !== 'supported' || !state.pages) throw new Error('현재 문서를 미리보기로 렌더링하지 못해 PDF를 만들지 않았습니다.');
    const pages = [];
    for (let i = 0; i < state.pages; i++) pages.push(await sessions.pageBytes(session, state.revision, i, meta));
    const name = basename(path, extname(path));
    const pdf = pagesToPdf(pages, {dpi, title: basename(path)});
    const folder = join(pdfRoot, randomUUID());
    await mkdir(folder, {recursive: true});
    const file = join(folder, `${name}.preview.pdf`);
    await writeFile(file, pdf);
    return {pdf: file, pages: state.pages, bytes: pdf.length, inputSha256: state.inputSha256, label: state.label};
  } finally {
    await sessions.release(session);
  }
}
