"""Root verifier; app/server run as node, with no model credential environment."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, '/opt/bench')
from provenance import stored_in_blocks, verify
from snapshot import capture  # /tests, next to this script

OUT = Path('/logs/verifier')
OUT.mkdir(parents=True, exist_ok=True)
PHASE = int(os.environ['BENCH_PHASE'])
ENV = {
    'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/home/node',
    'NPM_CONFIG_USERCONFIG': '/etc/bench-npmrc', 'NPM_CONFIG_GLOBALCONFIG': '/etc/bench-npm-globalrc',
    'NPM_CONFIG_CACHE': '/home/node/.npm', 'AWS_EC2_METADATA_DISABLED': 'true',
    'BLOCKS_DISABLE_TELEMETRY': '1', 'CI': '1', 'BENCH_PHASE': str(PHASE),
}
server = None
server_log = None


def stop():
    global server
    if server is not None:
        try:
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
        server = None
    # The agent must not keep a stale server between verification and edits.
    subprocess.run(['pkill', '-KILL', '-u', 'node'], check=False)


def start():
    global server, server_log
    server_log = (OUT / 'server.log').open('a')
    server = subprocess.Popen(
        ['runuser', '-u', 'node', '--', 'npm', 'run', 'dev'], cwd='/app/todo-app',
        env=ENV, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(60):
        if server.poll() is not None:
            raise RuntimeError('local_server_exited')
        try:
            with urllib.request.urlopen('http://localhost:3000', timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            pass
        time.sleep(1)
    raise RuntimeError('local_server_timeout')


def command(args, filename, timeout=120, app=False):
    with (OUT / filename).open('a') as log:
        subprocess.run(args, cwd='/app/todo-app' if app else '/tests', env=ENV,
                       stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=True)


result = {'phase': PHASE, 'status': 'failed', 'checks': {}}
stage = 'package_provenance'
try:
    stop()
    # Replay input: the app exactly as the agent left it (servers killed) and the records earlier
    # phases seeded, before this verifier builds, starts or mutates anything. Written first so it
    # exists whether the checks pass, fail or time out; never a check itself.
    try:
        capture(Path('/app/todo-app'), Path('/var/lib/harbor-verifier/state.json'), OUT / 'snapshot.tar.gz')
        result['snapshot'] = True
    except Exception as error:
        result['snapshot'] = False
        print(f'snapshot failure: {type(error).__name__}', file=sys.stderr)
    provenance = verify()
    (OUT / 'provenance.json').write_text(json.dumps(provenance, indent=2))
    result['checks']['package_provenance'] = True
    stage = 'build'
    command(['runuser', '-u', 'node', '--', 'npm', 'run', 'build'], 'build.log', app=True)
    result['checks']['build'] = True
    stage = 'server_start'
    start()
    stage = 'ui_exercise'
    command(['node', '/tests/ui.mjs', 'exercise'], 'ui.log')
    result['checks']['all_phases_and_reload'] = True
    stop()
    if server_log:
        server_log.close()
    # Heuristic: Blocks mocks persist under .bb-data, so verifier records stored anywhere else
    # (own files, browser storage) fail here. A backend writing its own files inside .bb-data
    # would still pass; the ApiNamespace import check and the prompt cover the rest.
    stage = 'blocks_persistence'
    titles = [item['title'] for item in json.loads(Path('/var/lib/harbor-verifier/state.json').read_text())['items']]
    assert titles and not stored_in_blocks(Path('/app/todo-app'), titles), 'records missing from .bb-data'
    result['checks']['blocks_persistence'] = True
    stage = 'server_restart'
    start()
    stage = 'ui_survival'
    command(['node', '/tests/ui.mjs', 'survival'], 'ui.log', timeout=60)
    result['checks']['server_restart_fresh_browser'] = True
    result['status'] = 'passed'
except Exception as error:
    # Details remain in local logs, never copied wholesale into public summary.
    result['error_type'] = type(error).__name__
    kind = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else (
        'assertion' if isinstance(error, AssertionError) else 'runtime')
    result['failure'] = {'stage': stage, 'kind': kind}
    print(f'verifier failure: {error}', file=sys.stderr)
finally:
    stop()
    if server_log:
        server_log.close()
    (OUT / 'verification.json').write_text(json.dumps(result, indent=2))
    (OUT / 'reward.json').write_text(json.dumps({'reward': int(result['status'] == 'passed')}))
