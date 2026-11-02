import {resolve} from 'node:path';

export function executableNames(platform = process.platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const suffix = platform === 'win32' ? '.exe' : '';
  return {node: `node${suffix}`, renderer: `HwpxPreview${suffix}`};
}

export function runtimePath(root, platform = process.platform) {
  return resolve(root, 'runtime/HwpxPreview', executableNames(platform).renderer);
}

export function platformMcpConfig(config, platform = process.platform) {
  const result = structuredClone(config);
  result.mcpServers.hwpx_file_preview.command = `./runtime/${executableNames(platform).node}`;
  return result;
}
