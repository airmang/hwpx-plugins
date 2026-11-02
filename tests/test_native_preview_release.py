"""Publication cannot silently ship the development or local helper matrix."""
import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_release', ROOT / 'scripts/validate_native_preview_assets.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def released():
    version = json.loads((ROOT / 'components/native-preview/package.json').read_text())['version']
    return {'schemaVersion': 'hwpx.native-preview-assets.v1', 'componentVersion': version,
            'releaseStatus': 'released', 'targets': {key: {
                'url': f'https://github.com/airmang/hwpx-plugins/releases/download/test/native-preview-{version}-{key}.tar.gz',
                'sha256': 'a' * 64, 'inventorySha256': 'b' * 64,
            } for key in gate.REQUIRED_TARGETS}}


def test_development_source_is_explicitly_not_publishable():
    data = json.loads((ROOT / 'packaging/native-preview-artifacts.json').read_text())
    gate.validate(data)
    if data['releaseStatus'] == 'unreleased':
        with pytest.raises(ValueError, match='Release requires'):
            gate.validate(data, release=True)


def test_pinned_platform_matrix_accepts_release_coordinates():
    gate.validate(released(), release=True)


@pytest.mark.parametrize('change', ['missing-windows', 'local-only', 'file-url', 'missing-inventory', 'wrong-version'])
def test_unfinished_or_unpinned_assets_block_publication(change):
    data = copy.deepcopy(released())
    item = data['targets']['darwin-arm64']
    if change == 'missing-windows':
        del data['targets']['win32-x64']
    elif change == 'local-only':
        data['localOnly'] = True
    elif change == 'file-url':
        item['url'] = 'file:///helper.tar.gz'
    elif change == 'missing-inventory':
        del item['inventorySha256']
    else:
        data['componentVersion'] = '0.0.0'
    with pytest.raises(ValueError):
        gate.validate(data, release=True)
