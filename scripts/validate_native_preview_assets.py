#!/usr/bin/env python3
"""Validate source helper coordinates; --release forbids unfinished/local assets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_TARGETS = {'darwin-arm64', 'win32-x64'}


def validate(manifest: dict, *, release: bool = False) -> None:
    if manifest.get('schemaVersion') != 'hwpx.native-preview-assets.v1':
        raise ValueError('Unknown native helper manifest schema')
    version = json.loads((ROOT / 'components/native-preview/package.json').read_text())['version']
    if manifest.get('componentVersion') != version:
        raise ValueError('Native helper component version mismatch')
    targets = manifest.get('targets')
    if not isinstance(targets, dict):
        raise ValueError('Native helper targets must be an object')
    if manifest.get('localOnly') or manifest.get('releaseStatus') not in {'unreleased', 'released'}:
        raise ValueError('Local helper coordinates cannot enter the source release manifest')
    if release and (manifest.get('releaseStatus') != 'released' or not REQUIRED_TARGETS <= targets.keys()):
        raise ValueError('Release requires observed Mac arm64 and Windows x64 helper assets')
    for key, artifact in targets.items():
        url = urlsplit(artifact.get('url', ''))
        if (url.scheme != 'https' or url.netloc != 'github.com' or url.fragment or url.query
                or not url.path.startswith('/airmang/hwpx-plugins/releases/download/')
                or not url.path.endswith(f'-{key}.tar.gz')):
            raise ValueError('Helper coordinates must identify a target-specific product release asset')
        for field in ['sha256', 'inventorySha256']:
            if not re.fullmatch(r'[0-9a-f]{64}', artifact.get(field, '')):
                raise ValueError(f'Native helper {field} must be pinned')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    try:
        validate(json.loads((ROOT / 'packaging/native-preview-artifacts.json').read_text()), release=args.release)
    except ValueError as exc:
        parser.exit(1, f'Native preview assets: {exc}\n')
    print('[OK] native preview asset coordinates' + (' are release-ready' if args.release else ' (development validation)'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
