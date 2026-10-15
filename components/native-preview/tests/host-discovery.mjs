// Read-only discovery through the installed Codex app-server's real plugin loader.
// This does not create/resume chats or impersonate a file click in the desktop UI.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';

const [codexPath, reportPath, detail = 'full'] = process.argv.slice(2);
if (!['full', 'toolsAndAuthOnly'].includes(detail)) throw new Error('Unsupported discovery detail');
const proc = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
const pending = new Map(); let id = 0;
proc.stderr.on('data', () => {});
const lines = createInterface({input: proc.stdout});
lines.on('line', line => {
  let message; try {message = JSON.parse(line);} catch {return;}
  const handler = pending.get(message.id);
  if (handler) {pending.delete(message.id); message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);}
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id, timeout = setTimeout(() => {pending.delete(requestId); reject(new Error(method + ' timed out'));}, 45000);
    pending.set(requestId, {resolve: x => {clearTimeout(timeout); resolve(x);}, reject: x => {clearTimeout(timeout); reject(x);}});
    proc.stdin.write(JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}) + '\n');
  });
}
try {
  await request('initialize', {clientInfo: {name: 'hwpx-file-preview-validation', title: 'HWPX file viewer discovery probe', version: '1.0.0'},
    capabilities: {experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true}});
  proc.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'initialized'}) + '\n');
  // The desktop's viewer catalog uses the unfiltered, paginated toolsAndAuthOnly
  // response. A targeted full response alone does not exercise that path.
  const servers = []; let cursor;
  do {
    const result = await request('mcpServerStatus/list', detail === 'full'
      ? {serverName: 'hwpx_file_preview', detail}
      : {detail, limit: 100, ...(cursor == null ? {} : {cursor})});
    servers.push(...(result.data ?? result.servers ?? []));
    cursor = result.nextCursor;
  } while (cursor != null);
  const own = servers.find(s => s.name === 'hwpx_file_preview');
  const tool = own?.tools?.hwpx_open;
  const accepted = own?.pluginId != null && own?.toolsError == null
    && tool?._meta?.ui?.resourceUri?.startsWith('ui://')
    && tool?._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'file' && e.extensions.includes('.hwpx'));
  const report = {status: accepted ? 'passed' : 'not_accepted', scope: 'Installed Codex app-server plugin discovery; not remote desktop file click',
    detail, unfilteredCatalog: detail === 'toolsAndAuthOnly', server: own ?? null, actualDesktopFileClickVerified: false};
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, servers: servers.length, own: own?.name, tools: Object.keys(own?.tools ?? {}), toolsError: own?.toolsError}));
  if (!accepted) process.exitCode = 1;
} finally {
  proc.stdin.end(); const end = Date.now() + 5000;
  while (proc.exitCode === null && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  if (proc.exitCode === null) proc.kill(); lines.close();
}
