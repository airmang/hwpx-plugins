"""Default plugin helper preparation without private fonts or native binaries."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_bootstrap', ROOT / 'components/native-preview/bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def fixture(tmp_path):
    suffix = '.exe' if bootstrap.sys.platform == 'win32' else ''
    files = {f'runtime/node{suffix}': b'fake node', f'runtime/HwpxPreview/HwpxPreview{suffix}': b'fake renderer',
             'server/index.mjs': b'// fixture', 'assets/viewer.html': b'<html></html>'}
    inventory = json.dumps({'version': '0.1.9', 'files': [{'path': k, 'sha256': hashlib.sha256(v).hexdigest()} for k, v in files.items()]}).encode()
    files['FILES.json'] = inventory
    archive = tmp_path / 'helper.tar.gz'
    with tarfile.open(archive, 'w:gz') as out:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o755 if name.startswith('runtime/') else 0o644
            out.addfile(info, io.BytesIO(data))
    return {'schemaVersion': 'hwpx.native-preview-assets.v1', 'componentVersion': '0.1.9', 'localOnly': True,
            'targets': {bootstrap.target_key(): {'url': archive.as_uri(), 'sha256': bootstrap.digest(archive),
                                                'inventorySha256': hashlib.sha256(inventory).hexdigest()}}}


def test_one_plugin_helper_install_reuses_verified_cache_offline(tmp_path, monkeypatch):
    manifest = fixture(tmp_path)
    installed = bootstrap.prepare(manifest, tmp_path / 'cache')
    assert installed.is_dir()
    monkeypatch.setattr(bootstrap, 'download', lambda *a, **k: pytest.fail('verified cache must not download'))
    assert bootstrap.prepare(manifest, tmp_path / 'cache') == installed
    (installed / 'server/index.mjs').write_bytes(b'changed')
    with pytest.raises(ValueError, match='verification'):
        bootstrap.prepare(manifest, tmp_path / 'cache')


def test_verified_helper_can_be_prepared_under_a_long_consumer_cache_path(tmp_path, monkeypatch):
    manifest = fixture(tmp_path)
    cache = tmp_path / ('long-cache-' * 12) / ('nested-' * 12)
    assert len(str(cache / ('a' * 64))) > 260
    installed = bootstrap.prepare(manifest, cache)
    assert (installed / 'FILES.json').is_file()
    monkeypatch.setattr(bootstrap, 'download', lambda *a, **k: pytest.fail('cache should be reusable offline'))
    assert bootstrap.prepare(manifest, cache) == installed


def test_cache_inventory_cannot_be_replaced_with_a_new_untrusted_receipt(tmp_path):
    manifest = fixture(tmp_path)
    installed = bootstrap.prepare(manifest, tmp_path / 'cache')
    (installed / 'FILES.json').write_text('{}')
    with pytest.raises(ValueError, match='inventory SHA256'):
        bootstrap.prepare(manifest, tmp_path / 'cache')


def test_corrupt_download_cannot_publish_a_generation(tmp_path):
    manifest = fixture(tmp_path)
    manifest['targets'][bootstrap.target_key()]['sha256'] = '0' * 64
    with pytest.raises(ValueError, match='archive SHA256'):
        bootstrap.prepare(manifest, tmp_path / 'cache')
    assert list((tmp_path / 'cache').iterdir()) == []


@pytest.mark.parametrize('name,kind', [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                                    ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE),
                                    ('C:/escape', tarfile.REGTYPE), ('a\\escape', tarfile.REGTYPE)])
def test_archive_cannot_escape_or_install_links(tmp_path, name, kind):
    archive = tmp_path / 'invalid.tar.gz'
    with tarfile.open(archive, 'w:gz') as out:
        info = tarfile.TarInfo(name); info.type = kind; info.linkname = '../outside'
        out.addfile(info)
    with pytest.raises(ValueError):
        bootstrap.extract(archive, tmp_path / 'owned')
    assert not (tmp_path / 'escape').exists()


def test_public_build_cannot_read_a_local_artifact(tmp_path):
    manifest = fixture(tmp_path)
    manifest.pop('localOnly')
    with pytest.raises(ValueError, match='HTTPS'):
        bootstrap.prepare(manifest, tmp_path / 'cache')


def test_missing_platform_has_an_explicit_unreleased_result(tmp_path):
    with pytest.raises(ValueError, match='not been released'):
        bootstrap.prepare({'schemaVersion': 'hwpx.native-preview-assets.v1', 'targets': {}}, tmp_path / 'cache')
