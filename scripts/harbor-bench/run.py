"""Run Harbor with an explicit host environment; publish only allowlisted evidence."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from public_result import collect


# Upper bound for one Harbor process: three 25-minute phases with their verifiers.
HARBOR_TIMEOUT_SECONDS = 6000


def run(work, credentials_expire_at=None):
    """Run one trial. With `credentials_expire_at` (Unix seconds), Harbor is stopped when the model
    credentials expire, and the trial is an infrastructure error: its late phases could fail on
    expired credentials alone.
    """
    identity = json.loads((work / 'identity.json').read_text())
    output = work / 'public'
    output.mkdir(exist_ok=True)
    # No GITHUB_TOKEN, ACTIONS_ID_TOKEN_REQUEST_*, runner temp, profile or host npm config.
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'DOCKER_HOST') if key in os.environ}
    for key in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        env[key] = os.environ[key]
    env.update(PYTHONPATH=str(Path(__file__).resolve().parent), AWS_REGION='us-east-1',
               AWS_EC2_METADATA_DISABLED='true', CLAUDE_CODE_USE_BEDROCK='1',
               HARBOR_DISABLE_TELEMETRY='1')
    exit_code = None
    error = None
    timeout = HARBOR_TIMEOUT_SECONDS
    if credentials_expire_at is not None:
        timeout = min(timeout, credentials_expire_at - time.time())
    try:
        if timeout <= 0:
            raise subprocess.TimeoutExpired('harbor', 0)
        # Raw logs remain runner-local. They can contain model credentials if an agent prints env.
        with (work / 'harbor.log').open('w') as log:
            process = subprocess.run(['harbor', 'run', '--config', str(work / 'job.json')],
                                     env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            exit_code = process.returncode
    except subprocess.TimeoutExpired:
        error = 'outer_timeout'
    except OSError:
        error = 'harbor_launch_error'
    outlived = credentials_expire_at is not None and time.time() >= credentials_expire_at
    if outlived:
        error = 'outlived_credentials'
    result = collect(work, identity, exit_code, error)
    if outlived:
        result['status'] = 'infrastructure_error'
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'arm': identity['arm'], 'status': result['status'], 'phases': len(result['phases'])}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('work', type=Path)
    parser.add_argument('--credentials-expire-at', type=int, default=None,
                        help='Unix time at which the model credentials expire')
    args = parser.parse_args()
    sys.exit(run(args.work.resolve(), args.credentials_expire_at))
