// A controlled MCP Apps bridge harness; never proof of the ChatGPT file registry.
import {AppBridge, PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.querySelector('iframe');
const token = document.body.dataset.token;
async function rpc(name, args) {
  const result = await fetch('/rpc', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Test-Token': token}, body: JSON.stringify({name, arguments: args})});
  if (!result.ok) throw new Error('harness RPC failed'); return result.json();
}
const bridge = new AppBridge(null, {name: 'HWPX controlled bridge test', version: '1.0.0'}, {serverTools: {}, logging: {}}, {hostContext: {theme: 'light', displayMode: 'inline'}});
bridge.oncalltool = params => rpc(params.name, params.arguments);
bridge.oninitialized = async () => {
  document.getElementById('host-state').textContent = '표준 MCP Apps 브리지 연결됨';
  const args = {file: {name: '앱 자동 미리보기.hwpx', resourceUri: 'host-resource://controlled-hwpx'}};
  await bridge.sendToolInput({arguments: args});
  await bridge.sendToolResult((await rpc('hwpx_open', args)));
};
document.getElementById('teardown').onclick = async () => {
  await bridge.teardownResource({}); iframe.remove(); document.getElementById('host-state').textContent = '뷰어 종료 확인';
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.src = '/widget';
