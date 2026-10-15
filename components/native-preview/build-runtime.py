#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Freeze the installed automation preview runtime for the current OS."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True,
                        help='new build directory; existing directories are refused')
    parser.add_argument('--font-directory', type=Path, required=True)
    parser.add_argument('--font-license', type=Path, required=True,
                        help='original redistribution notice for the supplied fonts')
    args = parser.parse_args()
    if importlib.util.find_spec('hwpx.layout.object_scene') is None:
        parser.error('install the core native-preview scene development branch first')
    if importlib.util.find_spec('hwpx_automation.preview_runtime') is None:
        parser.error('install python-hwpx-automation[native-preview] from the development branch')
    font_names = ['HCRBatang.ttf', 'HCRBatang-Bold.ttf', 'HCRDotum.ttf', 'HCRDotum-Bold.ttf']
    for name in font_names:
        if not (args.font_directory / name).is_file():
            parser.error('missing explicit font resource: ' + name)
    if not args.font_license.is_file():
        parser.error('the original font notice must be supplied')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    resources = root / 'resources'
    fonts = resources / 'fonts'
    fonts.mkdir(parents=True)
    notices = resources / 'licenses'
    notices.mkdir()
    for name in font_names:
        shutil.copyfile(args.font_directory / name, fonts / name)
    shutil.copyfile(args.font_license, notices / 'Font-NOTICE.txt')
    shutil.copytree(Path(__file__).with_name('notices'), notices / 'native')
    python_notices = [Path(sys.base_prefix, 'LICENSE.txt'),
                      Path(sys.base_prefix, f'lib/python{sys.version_info.major}.{sys.version_info.minor}/LICENSE.txt')]
    python_license = next((p for p in python_notices if p.is_file()), None)
    if python_license is None:
        raise ValueError('Python distribution license was not found')
    shutil.copyfile(python_license, notices / 'Python-LICENSE.txt')
    packages = ['python-hwpx', 'python-hwpx-automation', 'lxml', 'Pillow',
                'fonttools', 'uharfbuzz', 'freetype-py', 'PyInstaller']
    for name in packages:
        distribution = metadata.distribution(name)
        for item in distribution.files or []:
            if any(word in item.name.upper() for word in ['LICENSE', 'COPYING', 'NOTICE']):
                source = Path(distribution.locate_file(item))
                if source.is_file():
                    destination = notices / name / item.as_posix()
                    # Distribution metadata must not escape the owned notice root.
                    if item.is_absolute() or '..' in item.parts:
                        continue
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
    entry = root / 'entry.py'
    entry.write_text('from hwpx_automation.preview_runtime.launcher import main\n'
                     'if __name__ == "__main__":\n    raise SystemExit(main())\n', encoding='utf-8')
    command = [sys.executable, '-m', 'PyInstaller', '--onedir', '--noconfirm', '--noupx',
               '--name', 'HwpxPreview', '--distpath', str(root / 'dist'),
               '--workpath', str(root / 'work'), '--specpath', str(root),
               '--collect-data', 'hwpx', '--collect-data', 'freetype',
               '--collect-data', 'hwpx_automation.preview_runtime',
               '--add-data', str(resources) + os.pathsep + 'hwpx_automation/preview_runtime/resources',
               str(entry)]
    if sys.platform == 'win32':
        command.insert(3, '--windowed')
    with (root / 'BUILD.log').open('w', encoding='utf-8') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    bundle = root / 'dist/HwpxPreview'
    files = [{'path': p.relative_to(bundle).as_posix(), 'bytes': p.stat().st_size,
              'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
             for p in sorted(bundle.rglob('*')) if p.is_file()]
    (root / 'BUNDLE-MANIFEST.json').write_text(json.dumps({
        'platform': sys.platform, 'bundle': str(bundle), 'files': files,
        'dependencies': {name: metadata.version(name) for name in packages},
        'fontSource': 'explicit caller-supplied resources; preserve original terms',
        'publicRelease': False,
    }, indent=2), encoding='utf-8')
    print(bundle)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
