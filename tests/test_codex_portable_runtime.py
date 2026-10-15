"""Exercise the shipped uv front door and immutable Windows runtime admission."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('portable_builder', 'scripts/build_hwpx_plugins.py')
runtime = load('portable_runtime', 'packaging/templates/codex_runtime.py')


def test_frontdoor_preserves_json_unicode_and_cwd_without_bash(tmp_path):
    arguments = [json.dumps({'path': 'C:/한글 공간/a.hwpx', 'quoted': '"value"'}), 'a b']
    command = builder.uv_python_command(
        "import json,os,sys; print(json.dumps([sys.argv[1:],os.getcwd()]))", arguments)
    assert command['command'] == 'uv'
    assert len(subprocess.list2cmdline([command['command'], *command['args']])) < 30000
    # Execute precisely the Python code uv receives, with an isolated owned cache.
    env = {**os.environ, 'LOCALAPPDATA': str(tmp_path / 'cache 공간'), 'XDG_CACHE_HOME': str(tmp_path / 'cache 공간')}
    argv = command['args'][command['args'].index('-I'):]
    result = subprocess.run([sys.executable, *argv], cwd=tmp_path, env=env,
                            capture_output=True, text=True, encoding='utf-8', check=True)
    received, cwd = json.loads(result.stdout)
    assert received == arguments
    assert Path(cwd) == tmp_path
    script = next((tmp_path / 'cache 공간').rglob('launcher.py'))
    script.write_text('raise RuntimeError("tampered")', encoding='utf-8')
    result = subprocess.run([sys.executable, *argv], cwd=tmp_path, env=env,
                            capture_output=True, text=True, encoding='utf-8')
    assert result.returncode != 0
    assert 'source verification failed' in result.stderr


def test_failed_relocated_runtime_never_replaces_current(tmp_path, monkeypatch):
    previous = {'generation': 'gen-' + '1' * 32}
    runtime.atomic_json(tmp_path / 'current.json', previous)
    monkeypatch.setattr(runtime, 'invoke', lambda *a, **kw: None)

    def verify(path, packages):
        if path.name == 'runtime':
            path.mkdir()
            return {'python-hwpx': '6.9.0'}
        raise ValueError('relocated admission failed')

    monkeypatch.setattr(runtime, 'verify', verify)
    with pytest.raises(ValueError, match='admission failed'):
        runtime.build(tmp_path, ['automation', 'core'])
    assert json.loads((tmp_path / 'current.json').read_text()) == previous


def test_refresh_preserves_active_generation_on_network_failure(tmp_path, monkeypatch):
    active = tmp_path / ('gen-' + '2' * 32)
    active.mkdir()
    observed = {'python-hwpx': '6.9.0', 'python-hwpx-automation': '7.4.0'}
    monkeypatch.setattr(runtime, 'settings', lambda _: (tmp_path, ['auto', 'core'], 'floor', True))
    monkeypatch.setattr(runtime, 'current', lambda *a: (active, observed))
    monkeypatch.setattr(runtime, 'invoke', lambda *a, **kw: (_ for _ in ()).throw(OSError('offline')))
    assert runtime.refresh({}) == 0
    state = json.loads((tmp_path / 'update-state.json').read_text())
    assert state['runtime']['installed'] == observed
    assert 'offline' in state['lastError']
    assert active.is_dir()


def test_corrupt_generation_pointer_cannot_escape(tmp_path):
    runtime.atomic_json(tmp_path / 'current.json', {'generation': '../outside'})
    assert runtime.current(tmp_path, ['auto', 'core']) is None


def test_refresh_child_does_not_inherit_mcp_pipes(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(runtime.subprocess, 'Popen', lambda argv, **kw: seen.update(kw))
    runtime.maybe_refresh(tmp_path, {}, True)
    assert seen['stdin'] == subprocess.DEVNULL
    assert seen['close_fds']
    assert seen['stdout'] == seen['stderr']


def test_real_os_lock_excludes_second_handle_and_releases(tmp_path):
    path = tmp_path / 'install.lock'
    with runtime.lock(path):
        with pytest.raises(TimeoutError):
            with runtime.lock(path, timeout=0):
                pytest.fail('second owner acquired the lock')
    with runtime.lock(path, timeout=0):
        pass


@pytest.mark.skipif(os.name != 'nt', reason='Windows hidden child stdio contract')
def test_windows_server_explicitly_inherits_all_three_mcp_streams(tmp_path, monkeypatch):
    monkeypatch.setenv('HWPX_AUTOMATION_DISABLE_LOCAL_EDITABLE', '1')
    monkeypatch.setattr(runtime, 'settings', lambda _: (tmp_path, ['auto', 'core'], 'floor', False))
    monkeypatch.setattr(runtime, 'current', lambda *a: (tmp_path / 'generation', {}))
    seen = {}
    def invoke(argv, **kw):
        seen.update(kw)
        assert 'hwpx_automation.mcp_cli' in argv[-1]
        return subprocess.CompletedProcess(argv, 0)
    monkeypatch.setattr(runtime, 'invoke', invoke)
    assert runtime.main({}, []) == 0
    assert seen['stdin'] is sys.stdin
    assert seen['stdout'] is sys.stdout
    assert seen['stderr'] is sys.stderr


@pytest.mark.skipif(os.name != 'nt', reason='Windows long Python import path')
def test_windows_imports_modules_beyond_win32_path_limit(tmp_path):
    directory = tmp_path / ('installed-generation-' * 6) / ('site-packages-' * 5)
    extended = Path('\\\\?\\' + str(directory))
    extended.mkdir(parents=True)
    (extended / 'owned_long_module.py').write_text('answer=42', encoding='utf-8')
    code = 'import sys\nsys.path.insert(0,sys.argv[1])\n' + runtime.WINDOWS_IMPORT_PATHS
    code += '\nimport owned_long_module; assert owned_long_module.answer==42'
    subprocess.run([sys.executable, '-I', '-c', code, str(directory)], check=True)


@pytest.mark.skipif(os.name != 'nt', reason='Windows frozen extension loader')
def test_windows_extension_loader_accepts_a_long_native_module_path(tmp_path):
    import _decimal
    directory = tmp_path / ('native-cache-' * 10) / ('extensions-' * 10)
    extended = Path('\\\\?\\' + str(directory))
    extended.mkdir(parents=True)
    shutil.copyfile(_decimal.__file__, extended / Path(_decimal.__file__).name)
    # Model a PYZ package whose native extension lives in the onedir filesystem.
    code = '''import runpy,sys,types
runpy.run_path(sys.argv[1])
package=types.ModuleType('owned');package.__path__=[sys.argv[2]]
sys.modules['owned']=package
import owned._decimal
assert owned._decimal.Decimal('1.25')*2==owned._decimal.Decimal('2.50')
assert owned._decimal.__file__.startswith('\\\\\\\\?\\\\')
'''
    subprocess.run([sys.executable, '-I', '-c', code,
                    str(ROOT / 'components/native-preview/windows_paths_hook.py'), str(directory)], check=True)
