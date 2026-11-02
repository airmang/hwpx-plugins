#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Prepare the plugin's pinned native helper, then hand MCP stdio to it."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024


def filesystem_path(path: Path) -> Path:
    """Use the Win32 extended path namespace without changing logical manifests."""
    value = os.path.abspath(path)
    if os.name == 'nt' and not value.startswith('\\\\?\\'):
        value = ('\\\\?\\UNC\\' + value[2:]) if value.startswith('\\\\') else ('\\\\?\\' + value)
    return Path(value)


def application_path(path: Path) -> Path:
    """Node's entrypoint resolver requires a drive/UNC path, not Win32 syntax."""
    value = str(path)
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return Path(value)


def target_key() -> str:
    machine = platform.machine().lower()
    arch = {'aarch64': 'arm64', 'amd64': 'x64', 'x86_64': 'x64'}.get(machine, machine)
    return f'{sys.platform}-{arch}'


def digest(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def relative_path(value: str) -> Path:
    pure = PurePosixPath(value)
    if not value or pure.is_absolute() or '..' in pure.parts or '\\' in value or ':' in value:
        raise ValueError('Invalid native helper member path')
    return Path(*pure.parts)


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != 'https':
            raise ValueError('Native helper redirect must remain HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(artifact: dict, destination: Path, *, local_only: bool) -> None:
    if not re.fullmatch(r'[0-9a-f]{64}', artifact.get('sha256', '')):
        raise ValueError('Missing native helper SHA256')
    url = urllib.parse.urlsplit(artifact['url'])
    if url.username or url.password or url.fragment:
        raise ValueError('Invalid native helper URL')
    if url.scheme == 'file' and local_only and not url.netloc:
        source = Path(urllib.request.url2pathname(url.path))
        if source.stat().st_size > MAX_ARCHIVE:
            raise ValueError('Native helper archive exceeds its budget')
        shutil.copyfile(source, destination)
    elif url.scheme == 'https':
        if url.hostname != 'github.com' or not url.path.startswith('/airmang/hwpx-plugins/releases/download/'):
            raise ValueError('Native helper must come from the product release')
        opener = urllib.request.build_opener(HttpsRedirect())
        with opener.open(artifact['url'], timeout=30) as response, destination.open('wb') as out:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ARCHIVE:
                    raise ValueError('Native helper archive exceeds its budget')
                out.write(chunk)
    else:
        raise ValueError('Native helper requires HTTPS; file URLs are local-build-only')
    if digest(destination) != artifact['sha256']:
        raise ValueError('Native helper archive SHA256 mismatch')


def extract(archive: Path, destination: Path) -> None:
    seen = set()
    total = 0
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            rel = relative_path(member.name)
            if member.name in seen or len(seen) >= 4096:
                raise ValueError('Duplicate or excessive native helper members')
            seen.add(member.name)
            target = destination / rel
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                total += member.size
                if total > MAX_EXPANDED:
                    raise ValueError('Native helper expanded size exceeds its budget')
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as inp, target.open('xb') as out:
                    shutil.copyfileobj(inp, out)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise ValueError('Native helper links and special files are forbidden')


def verify(root: Path, expected_version: str, inventory_sha: str) -> None:
    receipt = root / 'FILES.json'
    if root.is_symlink() or receipt.is_symlink() or not re.fullmatch(r'[0-9a-f]{64}', inventory_sha) or digest(receipt) != inventory_sha:
        raise ValueError('Native helper inventory SHA256 mismatch')
    if receipt.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Native helper inventory is too large')
    inventory = json.loads((root / 'FILES.json').read_text(encoding='utf-8'))
    if inventory['version'] != expected_version:
        raise ValueError('Native helper component version mismatch')
    expected = {'FILES.json'}
    for item in inventory['files']:
        path = root / relative_path(item['path'])
        if item['path'] in expected or path.is_symlink() or not path.is_file() or digest(path) != item['sha256']:
            raise ValueError('Native helper installed-file verification failed')
        expected.add(item['path'])
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != expected or any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Native helper inventory does not match the installed files')
    suffix = '.exe' if sys.platform == 'win32' else ''
    required = {f'runtime/node{suffix}', f'runtime/HwpxPreview/HwpxPreview{suffix}', 'server/index.mjs', 'assets/viewer.html'}
    if not required <= expected:
        raise ValueError('Incomplete native helper package')
    if os.name != 'nt' and any(not os.access(root / p, os.X_OK) for p in required if p.startswith('runtime/')):
        raise ValueError('Native helper executable permissions are missing')


def prepare(manifest: dict, cache: Path) -> Path:
    if manifest.get('schemaVersion') != 'hwpx.native-preview-assets.v1':
        raise ValueError('Unknown native helper manifest')
    key = target_key()
    artifact = manifest.get('targets', {}).get(key)
    if artifact is None:
        raise ValueError(f'Native preview has not been released for {key} in this plugin build')
    sha = artifact.get('sha256', '')
    if not re.fullmatch(r'[0-9a-f]{64}', sha):
        raise ValueError('Missing native helper SHA256')
    cache = filesystem_path(cache)
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    generation = cache / sha
    if generation.exists():
        verify(generation, manifest['componentVersion'], artifact['inventorySha256'])
        return generation
    # Each starter owns its staging directory. A concurrent successful starter
    # wins the atomic rename; no shared generation is deleted or overwritten.
    with tempfile.TemporaryDirectory(prefix='.native-', dir=cache) as staging:
        staging = Path(staging)
        archive = staging / 'helper.tar.gz'
        download(artifact, archive, local_only=manifest.get('localOnly') is True)
        unpacked = staging / 'helper'
        unpacked.mkdir()
        extract(archive, unpacked)
        verify(unpacked, manifest['componentVersion'], artifact['inventorySha256'])
        try:
            unpacked.rename(generation)
        except OSError:
            if not generation.is_dir():
                raise
            verify(generation, manifest['componentVersion'], artifact['inventorySha256'])
    return generation


def main() -> int:
    manifest = json.loads(sys.argv[1])
    cache_base = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) if os.name == 'nt' else Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache')))
    root = application_path(prepare(manifest, cache_base / 'hwpx-plugin/native-preview'))
    node = root / 'runtime' / ('node.exe' if os.name == 'nt' else 'node')
    command = [str(node), str(root / 'server/index.mjs')]
    env = dict(os.environ)
    # A machine-local prototype override must never redirect an integrated
    # plugin to an older renderer or inject unrelated Python/Node code.
    for name in ['HWPX_PREVIEW_RUNTIME', 'PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'NODE_PATH']:
        env.pop(name, None)
    if os.name != 'nt':
        os.execve(node, command, env)
    return subprocess.call(command, env=env)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, tarfile.TarError) as exc:
        print(f'HWPX native preview: {exc}', file=sys.stderr)
        raise SystemExit(1)
