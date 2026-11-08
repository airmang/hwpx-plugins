# SPDX-License-Identifier: Apache-2.0
"""Windows uv-managed editing runtime; POSIX keeps the canonical shell launcher."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import sysconfig
import tempfile
import time
import uuid


WINDOWS_IMPORT_PATHS = r'''
import os,sys
if os.name == 'nt':
    def extended(value):
        value=os.path.abspath(value)
        if value.startswith('\\\\?\\'):
            return value
        return ('\\\\?\\UNC\\'+value[2:]) if value.startswith('\\\\') else ('\\\\?\\'+value)
    sys.path[:]=[extended(value) for value in sys.path]
'''


def invoke(argv, **options):
    options.setdefault('check', True)
    if os.name == 'nt':
        options.setdefault('creationflags', subprocess.CREATE_NO_WINDOW)
    return subprocess.run(argv, **options)


def python_at(root):
    return root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def lock(path, timeout=180):
    # The OS releases this byte lock on process exit, including interrupted
    # installations. No PID guessing, stale-lock deletion or shared-directory move.
    with path.open('a+b') as handle:
        handle.write(b'0'); handle.flush()
        end = time.monotonic() + timeout
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, OSError):
                if time.monotonic() >= end:
                    raise TimeoutError('HWPX runtime installation lock timed out')
                time.sleep(.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def expected_version(request):
    match = re.search(r'==([^;,\s]+)', request)
    if match:
        return match.group(1)
    match = re.search(r'-(\d[^-/]*)-py3-none-any\.whl$', request.replace('\\', '/'))
    return match.group(1) if match else None


def verify(root, packages):
    code = WINDOWS_IMPORT_PATHS + '''import json,sys
from importlib.metadata import version
import hwpx
from hwpx_automation.quality import capability_state
observed={name:version(name) for name in ['python-hwpx','python-hwpx-automation']}
expected=json.loads(sys.argv[1])
assert all(observed[name]==value for name,value in expected.items() if value), (observed,expected)
assert capability_state().get('ok'), 'HWPX capability handshake failed'
print(json.dumps(observed))
'''
    expected = {'python-hwpx-automation': expected_version(packages[0]),
                'python-hwpx': expected_version(packages[1])}
    result = invoke([str(python_at(root)), '-I', '-c', code, json.dumps(expected)],
                    capture_output=True, text=True, encoding='utf-8', timeout=30)
    return json.loads(result.stdout)


def current(root, packages):
    try:
        name = json.loads((root / 'current.json').read_text(encoding='utf-8'))['generation']
        if not re.fullmatch(r'gen-[a-f0-9]{32}', name):
            return None
        generation = root / name
        return generation, verify(generation, packages)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def build(root, packages):
    # Build in a private staging directory and only publish an admitted, relocated
    # environment. Older generations, including a failed refresh, stay untouched.
    with tempfile.TemporaryDirectory(prefix='.build-', dir=root) as staging:
        candidate = Path(staging) / 'runtime'
        invoke(['uv', 'venv', '--quiet', '--relocatable', '--python', sys.executable, str(candidate)],
               stdout=sys.stderr)
        invoke(['uv', 'pip', 'install', '--quiet', '--python', str(python_at(candidate)), *packages],
               stdout=sys.stderr)
        verify(candidate, packages)
        admitted = root / ('gen-' + uuid.uuid4().hex)
        candidate.rename(admitted)
        observed = verify(admitted, packages)
        atomic_json(root / 'current.json', {'generation': admitted.name})
        return admitted, observed


def write_state(root, observed, channel, auto, error=None):
    atomic_json(root / 'update-state.json', {
        'schemaVersion': 'hwpx.stack-update-state.v1',
        'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'autoUpdate': auto, 'channel': channel,
        'runtime': {'installed': observed, 'latestAvailable': observed},
        'pluginBundle': {'installed': os.environ.get('HWPX_SKILL_VERSION'), 'latestKnown': None},
        'lastError': error,
    })


def settings(config):
    channel = os.environ.get('HWPX_STACK_CHANNEL', 'floor')
    if channel not in {'floor', 'verified'}:
        raise ValueError('HWPX_STACK_CHANNEL must be floor or verified')
    defaults = config[channel]
    packages = [os.environ.get('HWPX_AUTOMATION_PACKAGE', os.environ.get('HWPX_MCP_SERVER_PACKAGE', defaults[0])),
                os.environ.get('HWPX_PYTHON_HWPX_PACKAGE', defaults[1])]
    auto = channel == 'floor' and os.environ.get('HWPX_STACK_AUTO_UPDATE', '1') == '1' and not any(expected_version(p) for p in packages)
    base = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'hwpx-plugin/runtime'
    runtime = Path(os.environ.get('HWPX_AUTOMATION_RUNTIME_ROOT', os.environ.get('HWPX_MCP_RUNTIME_ROOT', os.environ.get('HWPX_MCP_SERVER_VENV', str(base)))))
    fingerprint = hashlib.sha256(json.dumps([packages, channel, sys.version, sysconfig.get_platform(), 'windows-generations-v1']).encode()).hexdigest()
    root = runtime / 'envs' / fingerprint
    if os.name == 'nt' and not str(root).startswith('\\\\?\\'):
        value = os.path.abspath(root)
        root = Path(('\\\\?\\UNC\\' + value[2:]) if value.startswith('\\\\') else ('\\\\?\\' + value))
    root.mkdir(parents=True, exist_ok=True)
    return root, packages, channel, auto


def refresh(config):
    root, packages, channel, auto = settings(config)
    if not auto:
        return 0
    try:
        with lock(root / 'refresh.lock', timeout=0):
            (root / 'last-check').touch()
            active = current(root, packages)
            if active is None:
                return 0
            generation, observed = active
            try:
                result = invoke(['uv', 'pip', 'install', '--dry-run', '--upgrade', '--python', str(python_at(generation)), *packages],
                                capture_output=True, text=True, encoding='utf-8', timeout=120)
                if re.search(r'^\s*\+ python-hwpx(?:-automation)?==', result.stdout + result.stderr, re.M):
                    with lock(root / 'prepare.lock'):
                        _, observed = build(root, packages)
                write_state(root, observed, channel, auto)
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                write_state(root, observed, channel, auto, 'refresh: ' + str(exc))
    except TimeoutError:
        pass
    return 0


def maybe_refresh(root, config, auto):
    if not auto:
        return
    try:
        hours = max(0, int(os.environ.get('HWPX_STACK_UPDATE_INTERVAL_HOURS', '24')))
    except ValueError:
        hours = 24
    stamp = root / 'last-check'
    if stamp.exists() and time.time() - stamp.stat().st_mtime < hours * 3600:
        return
    # No inherited MCP pipes or visible console; only this process's own refresh.
    with (root / 'refresh.log').open('ab') as log:
        options = {'stdin': subprocess.DEVNULL, 'stdout': log, 'stderr': log, 'close_fds': True}
        if os.name == 'nt':
            options['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
        else:
            options['start_new_session'] = True
        subprocess.Popen([sys.executable, '-I', __file__, json.dumps(config), '--refresh'], **options)


def main(config, arguments):
    if os.name != 'nt':
        os.execvpe('bash', ['bash', '-c', config['posix'], 'hwpx-managed-launcher', *arguments], os.environ.copy())
    if arguments == ['--refresh']:
        return refresh(config)
    editing = os.environ.get('HWPX_AUTOMATION_REPO', os.environ.get('HWPX_MCP_SERVER_REPO', ''))
    core = os.environ.get('PYTHON_HWPX_REPO', '')
    if os.environ.get('HWPX_AUTOMATION_DISABLE_LOCAL_EDITABLE', os.environ.get('HWPX_MCP_DISABLE_LOCAL_EDITABLE', '0')) != '1' and editing and core and all((Path(p) / 'pyproject.toml').is_file() for p in [editing, core]):
        return invoke(['uv', 'run', '--no-project', '--no-config', '--no-env-file', '--with-editable', core + '[preview]',
                       '--with-editable', editing + '[mcp,oracle]', 'hwpx-automation-mcp', *arguments], check=False).returncode
    root, packages, channel, auto = settings(config)
    active = current(root, packages)
    if active is None:
        with lock(root / 'prepare.lock'):
            active = current(root, packages)
            if active is None:
                active = build(root, packages)
                write_state(root, active[1], channel, auto)
                (root / 'last-check').touch()
    generation, _ = active
    os.environ['HWPX_STACK_UPDATE_STATE'] = str(root / 'update-state.json')
    maybe_refresh(root, config, auto)
    code = WINDOWS_IMPORT_PATHS + '\nfrom hwpx_automation.mcp_cli import main; main()'
    return invoke([str(python_at(generation)), '-I', '-c', code, *arguments],
                  stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main(json.loads(sys.argv[1]), sys.argv[2:]))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print('HWPX editing runtime: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
