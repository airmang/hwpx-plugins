import {cp, mkdir, readFile, writeFile, readdir, chmod, stat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {executableNames, platformMcpConfig} from './server/platform.mjs';

const [targetArg, runtimeArg, nodeArg] = process.argv.slice(2);
if (!targetArg || !runtimeArg || !nodeArg) throw new Error('Usage: node prepare-local.mjs NEW_MARKETPLACE_ROOT HWPX_RUNTIME_FOLDER NODE_EXE');
const names = executableNames();
// Fail before creating a marketplace if the selected runtime is for another OS.
if (!(await stat(join(resolve(runtimeArg), names.renderer))).isFile()) throw new Error('Runtime executable missing for ' + process.platform);
const target = resolve(targetArg), root = join(target, 'plugins/hwpx-file-preview');
await mkdir(target, {recursive: false}); await mkdir(root, {recursive: true});
for (const path of ['plugin.json', 'mcp.json', '.codex-plugin', 'README.md']) await cp(path, join(root, path), {recursive: true});
for (const path of ['server', 'assets']) await cp(join('dist', path), join(root, path), {recursive: true});
const mcp = JSON.stringify(platformMcpConfig(JSON.parse(await readFile('mcp.json', 'utf8'))), null, 2) + '\n';
await writeFile(join(root, 'mcp.json'), mcp);
await writeFile(join(root, '.mcp.json'), mcp);
await mkdir(join(root, 'runtime'), {recursive: true});
await cp(resolve(nodeArg), join(root, 'runtime', names.node), {dereference: true});
// PyInstaller's macOS bundle contains dylib aliases. Materialize them so the
// portable plugin contains only regular files, including when cached by Codex.
await cp(resolve(runtimeArg), join(root, 'runtime/HwpxPreview'), {recursive: true, dereference: true});
if (process.platform !== 'win32') {
  await chmod(join(root, 'runtime', names.node), 0o755);
  await chmod(join(root, 'runtime/HwpxPreview', names.renderer), 0o755);
}
await mkdir(join(root, 'licenses'), {recursive: true});
await cp(resolve('../../LICENSE'), join(root, 'licenses/Apache-2.0.txt'));
await cp(resolve('../../NOTICE'), join(root, 'licenses/python-hwpx-NOTICE.txt'));
await cp('node-LICENSE.txt', join(root, 'licenses/Node-LICENSE.txt'));
for (const dep of await readdir('node_modules/.pnpm')) {
  const modules = join('node_modules/.pnpm', dep, 'node_modules');
  const collect = async (directory, name = '') => {
    let items; try {items = await readdir(directory, {withFileTypes: true});} catch {return;}
    for (const item of items) {
      if (item.isDirectory() && item.name.startsWith('@')) await collect(join(directory, item.name), item.name + '-');
      else if (item.isDirectory()) {
        const files = await readdir(join(directory, item.name));
        for (const file of files.filter(f => /^(license|licence|copying|notice)(\.|$)/i.test(f))) {
          await cp(join(directory, item.name, file), join(root, 'licenses', dep.replace(/[^A-Za-z0-9._-]/g, '_') + '-' + name + item.name + '-' + file), {recursive: true});
        }
      }
    }
  };
  await collect(modules);
}
await mkdir(join(target, '.agents/plugins'), {recursive: true});
await writeFile(join(target, '.agents/plugins/marketplace.json'), JSON.stringify({name: 'hwpx-local', interface: {displayName: 'HWPX Local'}, plugins: [{
  name: 'hwpx-file-preview', source: {source: 'local', path: './plugins/hwpx-file-preview'},
  policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Productivity',
}]}, null, 2));
const files = [];
async function inventory(folder, prefix = '') {
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    const path = join(folder, entry.name), rel = prefix + entry.name;
    if (entry.isDirectory()) await inventory(path, rel + '/');
    else if (entry.isFile()) {const data = await readFile(path); files.push({path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});}
    else throw new Error('Package contains a symlink or unsupported file');
  }
}
await inventory(root);
const {version} = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(join(target, 'PACKAGE-MANIFEST.json'), JSON.stringify({name: 'hwpx-file-preview', version, platform: process.platform, arch: process.arch, files, publicRelease: false, sourceDocumentsBundled: false}, null, 2));
console.log(JSON.stringify({target, files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0)}));
