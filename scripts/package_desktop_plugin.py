#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Assemble one hwpx-plugin marketplace, including its native helper assets."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from build_hwpx_plugins import ROOT, PACKAGING, render_claude_mcp_config, render_mcp_config


def digest(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True, help='target-native HwpxPreview onedir build')
    parser.add_argument('--node', type=Path, required=True, help='target-native Node 24 executable')
    parser.add_argument('--output', type=Path, required=True, help='new marketplace directory')
    parser.add_argument('--version', help='local candidate plugin version; source release coordinates remain unchanged')
    parser.add_argument('--host', choices=['codex', 'claude'], default='codex', help='desktop host whose default plugin bundle is assembled')
    parser.add_argument('--test-namespace', action='store_true', help='isolate the automation alias from an already installed plugin during local UI tests')
    args = parser.parse_args()
    output = args.output.resolve()
    component = ROOT / 'components/native-preview'
    node, runtime = args.node.resolve(), args.runtime.resolve()
    spec = importlib.util.spec_from_file_location('hwpx_native_bootstrap', component / 'bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    target_key = bootstrap.target_key()
    output.mkdir(parents=True, exist_ok=False)
    # Reuse the tested component builder and its complete dependency notices.
    subprocess.run([str(node), 'build.mjs'], cwd=component, check=True)
    with tempfile.TemporaryDirectory(prefix='.assemble-', dir=bootstrap.filesystem_path(output)) as temporary:
        Path(temporary).resolve().relative_to(bootstrap.filesystem_path(output).resolve())
        staged = Path(temporary) / 'helper-source'
        subprocess.run([str(node), 'prepare-local.mjs', str(staged), str(runtime), str(node)], cwd=component, check=True)
        helper = Path(temporary) / 'helper'
        helper.mkdir()
        for name in ['server', 'assets', 'runtime', 'licenses']:
            shutil.copytree(staged / 'plugins/hwpx-file-preview' / name, helper / name)
        version = json.loads((component / 'package.json').read_text(encoding='utf-8'))['version']
        files = [{'path': p.relative_to(helper).as_posix(), 'sha256': digest(p)} for p in sorted(helper.rglob('*')) if p.is_file()]
        inventory = helper / 'FILES.json'
        inventory.write_text(json.dumps({'version': version, 'files': files}, indent=2), encoding='utf-8')
        artifacts = output / 'artifacts'
        artifacts.mkdir()
        archive = artifacts / f'native-preview-{version}-{target_key}.tar.gz'
        with tarfile.open(archive, 'w:gz') as packed:
            for path in sorted(helper.rglob('*')):
                if path.is_file():
                    if path.is_symlink():
                        raise ValueError('Helper sources must contain only regular files')
                    packed.add(path, arcname=path.relative_to(helper).as_posix(), recursive=False)
        manifest = {
            'schemaVersion': 'hwpx.native-preview-assets.v1', 'componentVersion': version,
            'releaseStatus': 'local-build', 'localOnly': True,
            'targets': {target_key: {'url': archive.as_uri(), 'sha256': digest(archive), 'inventorySha256': digest(inventory)}},
        }
    # A single marketplace identity owns both the normal automation tools and
    # native file viewer. No hwpx-file-preview plugin entry is installed.
    plugin = output / 'plugins/hwpx-plugin'
    shutil.copytree(ROOT / f'plugins/{args.host}/hwpx-plugin', plugin)
    if args.host == 'claude':
        mcp = json.loads(render_claude_mcp_config((PACKAGING / 'templates/claude.mcp.json').read_text(encoding='utf-8'), manifest))
        metadata = plugin / '.claude-plugin/plugin.json'
    else:
        mcp = json.loads(render_mcp_config(
            (PACKAGING / 'templates/codex.mcp.json').read_text(encoding='utf-8'),
            (PACKAGING / 'templates/hwpx-automation-mcp').read_text(encoding='utf-8'), manifest,
        ))
        metadata = plugin / '.codex-plugin/plugin.json'
    data = json.loads(metadata.read_text(encoding='utf-8'))
    if args.version:
        data['version'] = args.version
        metadata.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        mcp['mcpServers']['hwpx']['env']['HWPX_SKILL_VERSION'] = args.version
    plugin_name = data['name']
    if args.test_namespace:
        mcp['mcpServers']['hwpx_integration_check'] = mcp['mcpServers'].pop('hwpx')
        if args.host == 'claude':
            # Claude loads one plugin per name and an already synced
            # hwpx-plugin takes precedence, so a local candidate needs its own.
            plugin_name = data['name'] = f"{data['name']}-check"
            metadata.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (plugin / '.mcp.json').write_text(json.dumps(mcp, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.host == 'claude':
        marketplace = output / '.claude-plugin'
        marketplace.mkdir(parents=True)
        (marketplace / 'marketplace.json').write_text(json.dumps({
            'name': 'hwpx-claude-local', 'owner': {'name': 'HWPX integration build'},
            'description': 'Local HWPX integration build; not a release.',
            'plugins': [{'name': plugin_name, 'source': './plugins/hwpx-plugin', 'description': data['description']}],
        }, ensure_ascii=False, indent=2), encoding='utf-8')
    else:
        marketplace = output / '.agents/plugins'
        marketplace.mkdir(parents=True)
        (marketplace / 'marketplace.json').write_text(json.dumps({
            'name': 'hwpx-integrated-local', 'interface': {'displayName': 'HWPX integration build'},
            'plugins': [{'name': 'hwpx-plugin', 'source': {'source': 'local', 'path': './plugins/hwpx-plugin'},
                         'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Productivity'}],
        }, indent=2), encoding='utf-8')
    (output / 'native-preview-artifacts.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    inventory = [{'path': p.relative_to(plugin).as_posix(), 'sha256': digest(p)} for p in sorted(plugin.rglob('*')) if p.is_file()]
    (output / 'PACKAGE-MANIFEST.json').write_text(json.dumps({
        'plugin': plugin_name, 'host': args.host, 'singlePluginInstall': True, 'nativeTarget': target_key,
        'localOnly': True, 'testNamespace': args.test_namespace, 'files': inventory,
        'nativeArtifacts': manifest,
    }, indent=2), encoding='utf-8')
    print(json.dumps({'marketplace': str(output), 'plugin': plugin_name, 'host': args.host, 'nativeTarget': target_key}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
