import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, realpath, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename, extname, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {getResourcePath} from '@openai/mcp-extensions/server';

const delay = ms => new Promise(r => setTimeout(r, ms));
const fileKey = p => process.platform === 'win32' ? p.toLowerCase() : p;
export async function authorizedFile(meta) {
  let supplied = getResourcePath(meta);
  // A remote host can supply the URI-style absolute Windows path /D:/... .
  // Node treats its leading slash as the current drive's root (C:\D:\...).
  // Convert only this unambiguous drive form, never names or opaque URIs.
  if (process.platform === 'win32' && /^[\\/][A-Za-z]:[\\/]/.test(supplied ?? '')) supplied = supplied.slice(1);
  if (!supplied || !isAbsolute(supplied)) throw new Error('앱에서 연 파일의 접근 권한을 받지 못했습니다. HWPX 파일을 다시 열어 주세요.');
  const path = await realpath(supplied);
  if (extname(path).toLowerCase() !== '.hwpx') throw new Error('HWPX 파일만 미리볼 수 있습니다.');
  const info = await stat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('입력 파일은 32 MiB 이하의 HWPX여야 합니다.');
  return path;
}

export function parseReady(text) {
  const ready = JSON.parse(text), url = new URL(ready.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || Number(url.port) !== ready.port || !/^[A-Za-z0-9_-]{32,}$/.test(url.hash.slice(1))) {
    throw new Error('로컬 렌더러 연결 정보를 확인할 수 없습니다.');
  }
  return {origin: url.origin, token: url.hash.slice(1)};
}

export function publicState(raw, session) {
  const latest = raw.latest, shown = raw.displayedJob;
  const result = latest?.result;
  return {
    session, state: latest?.state ?? 'starting', revision: raw.displayed ?? null,
    pages: shown?.result?.status === 'supported' ? shown.result.pages : 0,
    label: latest?.label ?? 'HWPX', sourceStatus: result?.status ?? null,
    inputSha256: shown?.inputSha256 ?? null,
    qualityValidated: shown?.result?.qualityValidated === true,
    unsupported: result?.unsupported ?? [], errors: result?.errors ?? [],
    error: result?.error ?? raw.watchError ?? null,
    fontSubstitutions: latest?.fontSubstitutions ?? {},
  };
}

export class PreviewSessions {
  constructor(runtime, {idleMs = 120000, maxSessions = 2} = {}) {
    this.runtime = resolve(runtime); this.sessions = new Map(); this.leases = new Map();
    this.workers = new Map(); this.pendingWorkers = new Map(); this.idleMs = idleMs; this.maxSessions = maxSessions;
    this.rootPromise = mkdtemp(join(tmpdir(), 'hwpx-file-plugin-'));
    this.timer = setInterval(() => this.reap().catch(e => console.error(e.message)), 15000);
    this.timer.unref(); this.closing = false; this.starts = 0;
  }
  async start(meta, {fontSubstitutions = {}, dpi = 300} = {}) {
    if (this.closing) throw new Error('미리보기 실행기가 종료 중입니다.');
    const path = await authorizedFile(meta);
    if (this.closing) throw new Error('미리보기 실행기가 종료 중입니다.');
    const key = JSON.stringify([fileKey(path), dpi, Object.entries(fontSubstitutions).sort(([a], [b]) => a.localeCompare(b))]);
    let entry = this.workers.get(key);
    if (entry && (entry.disposed || entry.spawnError || entry.proc.exitCode !== null)) {await this.dispose(entry); entry = null;}
    if (!entry) {
      let pending = this.pendingWorkers.get(key);
      if (!pending) {
        if (new Set([...this.workers.keys(), ...this.pendingWorkers.keys()]).size >= this.maxSessions) throw new Error('동시에 두 문서까지 미리볼 수 있습니다. 다른 미리보기를 닫아 주세요.');
        this.starts++;
        pending = this.launch(path, key, {fontSubstitutions, dpi}).finally(() => {this.starts--; this.pendingWorkers.delete(key);});
        this.pendingWorkers.set(key, pending);
      }
      entry = await pending;
    }
    if (this.closing || entry.disposed) throw new Error('미리보기 실행기가 종료 중입니다.');
    // Each view gets its own lease, while retries for the same file share a
    // worker. Closing one tab cannot terminate another tab's preview.
    const session = randomUUID(); this.sessions.set(session, entry); this.leases.set(session, Date.now());
    try {return publicState(await (await this.api(entry, '/api/status')).json(), session);}
    catch (e) {await this.release(session); throw e;}
  }
  async launch(path, key, {fontSubstitutions, dpi}) {
    let entry;
    try {
      if (!(await stat(this.runtime)).isFile()) throw new Error('로컬 렌더러 실행 파일을 찾을 수 없습니다.');
      const id = randomUUID(), root = await this.rootPromise, folder = join(root, id);
      await mkdir(folder);
      const readyFile = join(folder, 'READY.json'), mapFile = join(folder, 'fonts.json');
      await writeFile(mapFile, JSON.stringify(fontSubstitutions));
      if (this.closing) throw new Error('미리보기 실행기가 종료 중입니다.');
      const env = {...process.env};
      for (const key of Object.keys(env)) if (/^(PYTHONPATH|PYTHONHOME)$/i.test(key)) delete env[key];
      const proc = spawn(this.runtime, ['--watch', path, '--no-browser', '--ready-file', readyFile, '--font-map', mapFile, '--dpi', String(dpi)],
        {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env});
      entry = {id, key, root, folder, path, proc, dpi, mapping: fontSubstitutions};
      proc.on('error', err => {entry.spawnError = err;});
      proc.stderr.on('data', () => {});
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (this.closing) throw new Error('미리보기 실행기가 종료 중입니다.');
        if (entry.spawnError || proc.exitCode !== null) throw new Error('로컬 렌더러를 시작하지 못했습니다.');
        try {entry.connection = parseReady(await readFile(readyFile, 'utf8')); break;}
        catch (e) {if (e.code !== 'ENOENT') throw e;}
        await delay(100);
      }
      if (!entry.connection) throw new Error('로컬 렌더러 시작 시간이 한도를 넘었습니다.');
      if (this.closing) throw new Error('미리보기 실행기가 종료 중입니다.');
      this.workers.set(key, entry); return entry;
    } catch (e) {if (entry) await this.dispose(entry); throw e;}
  }
  async lookup(id, meta) {
    const entry = this.sessions.get(id);
    if (!entry || entry.disposed) throw new Error('미리보기 세션이 끝났습니다. 파일을 다시 열어 주세요.');
    if (fileKey(await authorizedFile(meta)) !== fileKey(entry.path)) throw new Error('현재 열린 파일과 미리보기 세션이 다릅니다.');
    this.leases.set(id, Date.now()); return entry;
  }
  async api(entry, route, {method = 'GET', body, headers = {}} = {}) {
    if (!entry.connection) throw new Error('렌더러에 연결되지 않았습니다.');
    const response = await fetch(entry.connection.origin + route, {method, body,
      headers: {'X-Preview-Token': entry.connection.token, ...headers}, signal: AbortSignal.timeout(15000), redirect: 'error'});
    if (!response.ok) throw new Error('로컬 렌더러 응답을 받지 못했습니다.');
    return response;
  }
  async state(id, meta) {const e = await this.lookup(id, meta); return publicState(await (await this.api(e, '/api/status')).json(), id);}
  async page(id, revision, index, meta) {
    const e = await this.lookup(id, meta), raw = await (await this.api(e, '/api/status')).json();
    if (revision !== raw.displayed || !Number.isInteger(index) || index < 0 || index >= (raw.displayedJob?.result?.pages ?? 0)) {
      throw new Error('페이지가 갱신되었습니다. 최신 미리보기를 기다려 주세요.');
    }
    const response = await this.api(e, `/api/pages/${revision}/p${index}.png`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 4 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      throw new Error('페이지 이미지가 크기 한도를 넘었거나 올바르지 않습니다.');
    }
    return {session: id, revision, index, mimeType: 'image/png', data: data.toString('base64')};
  }
  async rerender(id, meta, mapping) {
    const e = await this.lookup(id, meta);
    // Restart with the chosen mapping so subsequent saves use the same explicit policy.
    await this.release(id); return this.start(meta, {fontSubstitutions: mapping, dpi: e.dpi});
  }
  async cancel(id, meta) {const e = await this.lookup(id, meta); await this.api(e, '/api/cancel', {method: 'POST', body: ''}); return this.state(id, meta);}
  async close(id, meta) {await this.lookup(id, meta); await this.release(id); return {closed: true};}
  async release(id) {
    const entry = this.sessions.get(id); this.sessions.delete(id); this.leases.delete(id);
    if (entry && ![...this.sessions.values()].includes(entry)) await this.dispose(entry);
  }
  async dispose(entry) {
    if (entry.disposed) return; entry.disposed = true;
    if (entry.connection && entry.proc.exitCode === null) await this.api(entry, '/api/shutdown', {method: 'POST', body: ''}).catch(() => {});
    const end = Date.now() + 5000;
    while (entry.proc.exitCode === null && !entry.spawnError && Date.now() < end) await delay(50);
    if (entry.proc.exitCode === null && !entry.spawnError) entry.proc.kill();
    if (this.workers.get(entry.key) === entry) this.workers.delete(entry.key);
    for (const [id, worker] of this.sessions) if (worker === entry) {this.sessions.delete(id); this.leases.delete(id);}
    // Only this instance's explicitly checked, newly created session directory is removed.
    if (dirname(resolve(entry.folder)) !== resolve(entry.root) || basename(entry.folder) !== entry.id) throw new Error('세션 정리 경로가 올바르지 않습니다.');
    await rm(entry.folder, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
  async reap() {for (const [id, touched] of [...this.leases]) if (Date.now() - touched > this.idleMs) await this.release(id);}
  async shutdown() {
    this.closing = true; clearInterval(this.timer);
    await Promise.allSettled([...this.workers.values()].map(e => this.dispose(e)));
    while (this.starts) await delay(50);
    await Promise.allSettled([...this.workers.values()].map(e => this.dispose(e)));
    const root = await this.rootPromise;
    if (dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('hwpx-file-plugin-')) await rm(root, {recursive: true, force: true});
  }
}
