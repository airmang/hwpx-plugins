import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {executableNames, runtimePath, platformMcpConfig} from '../server/platform.mjs';

test('native runtime and portable MCP command agree on each supported OS', () => {
  const config = {mcpServers: {hwpx_file_preview: {command: './runtime/node.exe', args: ['./server/index.mjs'], cwd: '${PLUGIN_ROOT}'}}};
  for (const platform of ['darwin', 'win32', 'linux']) {
    const suffix = platform === 'win32' ? '.exe' : '';
    assert.deepEqual(executableNames(platform), {node: `node${suffix}`, renderer: `HwpxPreview${suffix}`});
    assert.equal(runtimePath('/plugin', platform), resolve('/plugin/runtime/HwpxPreview', `HwpxPreview${suffix}`));
    const result = platformMcpConfig(config, platform);
    assert.equal(result.mcpServers.hwpx_file_preview.command, `./runtime/node${suffix}`);
    assert.equal(result.mcpServers.hwpx_file_preview.cwd, '${PLUGIN_ROOT}');
    assert.deepEqual(result.mcpServers.hwpx_file_preview.args, ['./server/index.mjs']);
  }
  assert.equal(config.mcpServers.hwpx_file_preview.command, './runtime/node.exe');
  assert.throws(() => executableNames('unknown'));
});
