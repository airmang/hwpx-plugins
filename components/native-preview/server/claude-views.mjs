import {createServer} from 'node:http';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

// Claude's desktop app shows local pages in its in-app Browser pane. The
// model only ever sees a single-use ticket URL; the browser exchanges it for
// an HttpOnly cookie scoped to one view. Renderer credentials, file paths and
// page bytes stay inside this process and the pane.
const TICKET_MS = 5 * 60 * 1000;
const MAX_VIEWS = 8;
const secret = () => randomBytes(32).toString('base64url');
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const VIEW = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = /^api\/pages\/(\d{1,9})\/(\d{1,3})\.png$/;

function scriptHash(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error('Claude viewer script is missing');
  return `'sha256-${createHash('sha256').update(script[1]).digest('base64')}'`;
}

function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function same(a, b) {
  const x = Buffer.from(a ?? ''), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ClaudeViews {
  constructor(sessions, viewerHtml, {ticketMs = TICKET_MS, maxViews = MAX_VIEWS} = {}) {
    this.sessions = sessions; this.html = Buffer.from(viewerHtml); this.ticketMs = ticketMs; this.maxViews = maxViews;
    this.csp = `default-src 'none'; script-src ${scriptHash(viewerHtml)}; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    this.views = new Map(); this.tickets = new Map(); this.listening = null; this.server = null; this.host = null;
  }
  origin() {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => this.reply(res, 500, {error: '미리보기 요청을 처리하지 못했습니다.'}));
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server; this.host = `127.0.0.1:${server.address().port}`;
        resolve(`http://${this.host}`);
      });
    });
    return this.listening;
  }
  prune() {
    const now = Date.now();
    for (const [id, view] of this.views) if (!this.sessions.sessions.has(view.session)) this.views.delete(id);
    for (const [ticket, entry] of this.tickets) if (entry.expires <= now || !this.views.has(entry.view)) this.tickets.delete(ticket);
  }
  async open(path, {fontSubstitutions, ticket = true} = {}) {
    const origin = ticket ? await this.origin() : null;
    this.prune();
    if (this.views.size >= this.maxViews) throw new Error('열린 미리보기가 너무 많습니다. 사용하지 않는 미리보기를 닫아 주세요.');
    const state = await this.sessions.start({path}, {fontSubstitutions});
    const view = {id: randomUUID(), session: state.session, path, secret: secret()};
    this.views.set(view.id, view);
    const opened = {view: view.id, state: {...state, session: undefined}};
    return ticket ? {...opened, url: this.ticket(view, origin), expiresInSeconds: this.ticketMs / 1000} : opened;
  }
  ticket(view, origin) {
    const ticket = secret();
    this.tickets.set(ticket, {view: view.id, expires: Date.now() + this.ticketMs});
    return `${origin}/open/${ticket}`;
  }
  view(id) {
    this.prune();
    const view = this.views.get(id);
    if (!view) throw new Error('미리보기가 끝났습니다. HWPX 미리보기를 다시 열어 주세요.');
    return view;
  }
  async reopen(id) {
    const view = this.view(id), origin = await this.origin();
    await this.sessions.lookup(view.session, {path: view.path});
    return {view: id, url: this.ticket(view, origin), expiresInSeconds: this.ticketMs / 1000};
  }
  async status(id) {
    const view = this.view(id);
    return {...await this.sessions.state(view.session, {path: view.path}), session: undefined, view: id};
  }
  async page(id, revision, index) {
    const view = this.view(id);
    return this.sessions.pageBytes(view.session, revision, index, {path: view.path});
  }
  async cancel(id) {
    const view = this.view(id);
    await this.sessions.cancel(view.session, {path: view.path});
    return this.status(id);
  }
  async close(id) {
    const view = this.view(id);
    this.views.delete(id);
    await this.sessions.release(view.session);
    this.prune();
    return {closed: true, view: id};
  }
  reply(res, status, body, headers = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': this.csp,
      'Cross-Origin-Resource-Policy': 'same-origin', ...headers,
    });
    res.end(data);
  }
  notice(res, status, text) {
    const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>HWPX 미리보기</title><p style="font:15px system-ui;padding:24px">${text}</p></html>`;
    this.reply(res, status, Buffer.from(html), {'Content-Type': 'text/html; charset=utf-8'});
  }
  async handle(req, res) {
    // Exact Host binding defeats DNS rebinding onto this loopback port.
    if (req.headers.host !== this.host) return this.reply(res, 403, {error: 'Invalid host'});
    const url = new URL(req.url, `http://${this.host}`);
    const parts = url.pathname.split('/');
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'open' && TICKET.test(parts[2])) {
      const entry = this.tickets.get(parts[2]);
      this.tickets.delete(parts[2]);
      this.prune();
      const view = entry && entry.expires > Date.now() ? this.views.get(entry.view) : null;
      if (!view) return this.notice(res, 410, '미리보기 주소가 만료되었거나 이미 사용되었습니다. Claude에게 HWPX 미리보기를 다시 열어 달라고 하세요.');
      res.writeHead(303, {
        Location: `/v/${view.id}/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Set-Cookie': `hwpx_view=${view.secret}; HttpOnly; SameSite=Strict; Path=/v/${view.id}/`,
      });
      return res.end();
    }
    if (parts[1] !== 'v' || !VIEW.test(parts[2] ?? '') || parts.length < 4) return this.reply(res, 404, {error: 'Not found'});
    const view = this.views.get(parts[2]);
    if (!view || !same(cookie(req, 'hwpx_view'), view.secret)) {
      return this.notice(res, 403, '이 미리보기를 열 권한이 없습니다. Claude에게 HWPX 미리보기를 다시 열어 달라고 하세요.');
    }
    const rest = parts.slice(3).join('/'), meta = {path: view.path};
    try {
      if (req.method === 'GET' && rest === '') return this.reply(res, 200, this.html, {'Content-Type': 'text/html; charset=utf-8'});
      if (req.method === 'GET' && rest === 'api/status') {
        return this.reply(res, 200, {...await this.sessions.state(view.session, meta), session: undefined});
      }
      const page = req.method === 'GET' ? rest.match(PAGE) : null;
      if (page) {
        const data = await this.sessions.pageBytes(view.session, Number(page[1]), Number(page[2]), meta);
        return this.reply(res, 200, data, {'Content-Type': 'image/png'});
      }
      if (req.method === 'POST' && rest === 'api/cancel') {
        if (req.headers.origin !== `http://${this.host}`) return this.reply(res, 403, {error: 'Invalid origin'});
        await this.sessions.cancel(view.session, meta);
        return this.reply(res, 200, {...await this.sessions.state(view.session, meta), session: undefined});
      }
    } catch (e) {
      const gone = !this.sessions.sessions.has(view.session);
      if (gone) this.views.delete(view.id);
      return this.reply(res, gone ? 410 : 409, {error: e.message});
    }
    return this.reply(res, 404, {error: 'Not found'});
  }
  async shutdown() {
    this.views.clear(); this.tickets.clear();
    if (this.server) await new Promise(resolve => {this.server.closeAllConnections?.(); this.server.close(() => resolve());});
  }
}
