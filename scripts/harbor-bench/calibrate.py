"""Local A/A calibration: N paid trials per arm from the SAME packages, to measure run-to-run
variance and choose a trial count. Each trial gets fresh 1-hour STS credentials for a
Bedrock-only role; the source profile's own credentials never reach Harbor or the agent.
Raw traces stay under --output.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

from prepare import prepare
from report import ARMS, METRICS, PHASES, TOTAL, aggregate, counted, eligible, load_trials, render, sample
from stats import POWER_GRID, cv, trials_for_median_change, trials_for_rate_drop, wilson
from traces import CREDENTIALS, pack
from trials import parse_trials

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
CHANGES = (0.1, 0.2, 0.3)
RATE_DROP = 0.2
COUNT_METRICS = ('turns', 'tool_calls')  # Whole-number metrics: relative scaling is not a real outcome.
LOAD_INTERVAL = 15
BUILD_ENV_DROP = ('S3_BUCKET', 'CLOUDFRONT_DOMAIN', 'CLOUDFRONT_DISTRIBUTION_ID')


def git(*args):
    return subprocess.run(['git', '-C', str(REPO), *args], check=True, capture_output=True, text=True).stdout.strip()


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def build_and_pack(commit, output):
    """README's local steps in a throwaway detached worktree, credential-free, like CI's packages job."""
    source = output / 'source'
    git('worktree', 'add', '--detach', str(source), commit)
    empty = output / 'empty-npmrc'
    empty.touch()
    env = {key: value for key, value in os.environ.items()
           if key not in BUILD_ENV_DROP and not key.startswith('AWS_')}
    env.update(HUSKY='0', BLOCKS_DISABLE_TELEMETRY='1', NPM_CONFIG_USERCONFIG='/dev/null',
               NPM_CONFIG_GLOBALCONFIG=str(empty), NPM_CONFIG_CACHE=str(output / 'npm-cache'))
    try:
        with (output / 'build.log').open('w') as log:
            for args in (['npm', 'ci'], ['npm', 'run', 'build'], ['npm', 'run', 'publish:local']):
                print('$ ' + ' '.join(args), flush=True)
                subprocess.run(args, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        shutil.copytree(source / 'dist-registry', output / 'registry')
    finally:
        subprocess.run(['git', '-C', str(REPO), 'worktree', 'remove', '--force', str(source)], check=False)
    return output / 'registry'


class LoadSampler(threading.Thread):
    """Host 1-minute load average; concurrent trials contend for CPU, which biases seconds and timeouts."""

    def __init__(self):
        super().__init__(daemon=True)
        self.samples, self.lock, self.done = [], threading.Lock(), threading.Event()

    def run(self):
        while not self.done.is_set():
            with self.lock:
                self.samples.append((time.time(), os.getloadavg()[0]))
            self.done.wait(LOAD_INTERVAL)

    def window(self, start, end):
        with self.lock:
            values = [load for at, load in self.samples if start <= at <= end]
        return {'mean': round(sum(values) / len(values), 2), 'max': max(values)} if values else {}


def profile_credentials(profile):
    """Fresh temporary credentials of an AWS profile, e.g. one backed by SSO or a credential_process.

    Exported per trial so a credential_process profile refreshes between trials. Returns (secrets, expiration).
    Harbor needs a session token, so long-lived keys are rejected. The agent can do whatever these allow.
    """
    process = subprocess.run(
        ['aws', 'configure', 'export-credentials', '--profile', profile, '--format', 'process'],
        env=profile_env(), capture_output=True, text=True, timeout=120)
    if process.returncode:
        raise RuntimeError('export-credentials failed: ' + process.stderr.strip()[-500:])
    credentials = json.loads(process.stdout)
    if not credentials.get('SessionToken'):
        raise RuntimeError(f'profile {profile} has no session token; use a profile with temporary credentials')
    values = (credentials['AccessKeyId'], credentials['SecretAccessKey'], credentials['SessionToken'])
    return dict(zip(CREDENTIALS, values)), credentials.get('Expiration')


def profile_env():
    # Resolve only the named profile, never ambient keys or a default profile from this shell.
    return {key: value for key, value in os.environ.items() if key not in (*CREDENTIALS, 'AWS_PROFILE')}


def caller_arn(profile):
    # Regional STS endpoint in the benchmark's region; some accounts reject the legacy global endpoint.
    process = subprocess.run(['aws', 'sts', 'get-caller-identity', '--profile', profile, '--region', 'us-east-1',
                              '--output', 'json'], env=profile_env(), capture_output=True, text=True, timeout=120)
    if process.returncode:
        raise RuntimeError('get-caller-identity failed: ' + process.stderr.strip()[-500:])
    return json.loads(process.stdout)['Arn']


def run_trial(args, output, sampler, arm, trial):
    work = output / 'runs' / f'{arm}-{trial}'
    record = {'arm': arm, 'trial': trial, 'work': str(work.relative_to(output))}
    started = time.time()
    record['started_at'] = now().isoformat()
    record['load_start'] = os.getloadavg()[0]
    try:
        secrets, expiration = profile_credentials(args.profile)
        record['credentials_expire_at'] = expiration
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'DOCKER_HOST') if key in os.environ}
        env.update(secrets)
        with (work / 'calibrate.log').open('w') as log:
            process = subprocess.run([sys.executable, str(ROOT / 'run.py'), str(work)], env=env,
                                     stdout=log, stderr=subprocess.STDOUT)
        record['run_exit_code'] = process.returncode
        # Same redacted trace format as CI, so local and CI traces are analysed alike.
        record['trace'] = pack(work, output / 'traces' / f'{arm}-{trial}.tar.gz', secrets)
        del secrets, env
    except Exception as error:  # One broken trial must not stop the calibration.
        record['calibration_error'] = type(error).__name__
    ended = time.time()
    record.update(ended_at=now().isoformat(), seconds=round(ended - started, 1),
                  load_end=os.getloadavg()[0], load=sampler.window(started, ended))
    expiry = record.get('credentials_expire_at')
    if expiry:
        record['outlived_credentials'] = ended > datetime.datetime.fromisoformat(expiry.replace('Z', '+00:00')).timestamp()
    collect_result(work, output, record)
    print(json.dumps({key: record.get(key) for key in ('arm', 'trial', 'status', 'seconds', 'calibration_error')}),
          flush=True)
    return record


def collect_result(work, output, record):
    """Copy a trial's public result for aggregation, excluding trials that outlived their credentials.

    Late phases of such a trial can fail on expired Bedrock credentials alone, so the copy is marked as an
    infrastructure error (dropped from rates and power estimates); the raw result stays in the work dir.
    """
    result = work / 'public' / 'result.json'
    if not result.exists():
        return
    data = json.loads(result.read_text())
    record['status'] = data.get('status')
    if record.get('outlived_credentials'):
        record['excluded'] = 'outlived_credentials'
        data = {**data, 'status': 'infrastructure_error', 'calibration_excluded': 'outlived_credentials'}
    target = output / 'results' / f'harbor-result-{record["arm"]}-{record["trial"]}'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'result.json').write_text(json.dumps(data, indent=2) + '\n')


def pooled(arms, name, key):
    """Values of one metric over counted trials that passed the phase; infrastructure errors never contribute."""
    return [v for results in arms.values() for result in results.values()
            if counted(result) and eligible(result, name) if (v := sample(result, name)[key]) is not None]


def calibration(arms, summary, **power_options):
    names = (*PHASES, TOTAL)
    rates, variation, power = {}, {}, {}
    for name in names:
        passes = sum(summary['arms'][arm]['phases'][name]['passes'] for arm in ARMS)
        n = sum(summary['arms'][arm]['phases'][name]['n'] for arm in ARMS)
        interval = wilson(passes, n)
        rate = passes / n if n else None
        rates[name] = {'passes': passes, 'n': n, 'rate': rate, 'wilson': list(interval) if interval else None,
                       'trials_per_arm_for_rate_drop': trials_for_rate_drop(rate, RATE_DROP)}
        variation[name], power[name] = {}, {}
        for _, key in METRICS:
            values = pooled(arms, name, key)
            coefficient = cv(values)
            variation[name][key] = {'pooled_n': len(values), 'pooled_cv': coefficient, **{
                f'{arm}_cv': summary['arms'][arm]['phases'][name]['metrics'][key]['cv'] for arm in ARMS}}
            # Scaling whole-number counts by 1.1 invents values no run can produce, so no estimate applies.
            power[name][key] = {f'{int(change * 100)}%': 'n/a' if key in COUNT_METRICS else
                                trials_for_median_change(values, change, **power_options) for change in CHANGES}
    return {'pass_rates': rates, 'cv': variation, 'trials_per_arm_80_power': power}


def number(value, digits=2):
    return '—' if value is None else f'{value:.{digits}f}'


def render_summary(config, records, report, extra):
    lines = ['# Harbor calibration (A/A)', '',
             f'- Revision: `{config["commit"]}` packed once; both arms install the same packages.',
             f'- Harness: `{config["harness_commit"]}`' + (' (with uncommitted harness changes)' if config['harness_dirty'] else ''),
             f'- Trials per arm: {config["trials"]}; concurrency: {config["concurrency"]}; host CPUs: {config["cpus"]}.',
             f'- Started {config["started_at"]}, finished {config["finished_at"]}.', '',
             report.replace('## Harbor agent check — advisory', '## Aggregate report', 1), '',
             '## Calibration', '',
             'Both arms are byte-identical, so every candidate − baseline interval above should include zero; '
             'an interval that excludes it is noise of that size or a harness bias.', '',
             '### Observed pass rates (both arms pooled)', '',
             '| Phase | Passes | Rate (Wilson 95%) | Trials/arm to detect a 20-point drop |', '|---|---:|---:|---:|']
    for name, rate in extra['pass_rates'].items():
        text = '—' if rate['rate'] is None else (
            f'{100 * rate["rate"]:.0f}% ({100 * rate["wilson"][0]:.0f}–{100 * rate["wilson"][1]:.0f}%)')
        lines.append(f'| {name} | {rate["passes"]}/{rate["n"]} | {text} | {rate["trials_per_arm_for_rate_drop"] or "—"} |')
    lines += ['', '### Coefficient of variation over passed phases', '',
              '| Phase | Metric | Baseline CV | Candidate CV | Pooled CV (n) | Trials/arm: 10% | 20% | 30% |',
              '|---|---|---:|---:|---:|---:|---:|---:|']
    for name, metrics in extra['cv'].items():
        for label, key in METRICS:
            entry, need = metrics[key], extra['trials_per_arm_80_power'][name][key]
            lines.append(f'| {name} | {label} | {number(entry["baseline_cv"])} | {number(entry["candidate_cv"])} | '
                         f'{number(entry["pooled_cv"])} ({entry["pooled_n"]}) | '
                         + ' | '.join(str(need[f'{int(c * 100)}%'] or '—') for c in CHANGES) + ' |')
    lines += ['', 'Trials per arm for 80% power with the report\'s own rule: both arms are resampled from the pooled '
              'passed-phase values, the candidate scaled by the target median change, and a run detects the change '
              'when the seeded bootstrap 95% interval of the median difference excludes zero (200 simulated runs per '
              f'size, sizes {", ".join(map(str, POWER_GRID))}; — means more than {POWER_GRID[-1]} or fewer than 6 '
              'pilot values). Turns and tool calls are whole-number counts, so scaling them does not simulate a real '
              'outcome: n/a there means this method does not apply, not that a change is undetectable. The pilot is '
              'itself a sample, so these are estimates. Size an A/B on the primary metric, cache-neutral cost; † '
              'metrics depend on prompt-cache warm-up order and are listed for variance tracking only. Pass-rate '
              'sizing is separate: the two-proportion normal approximation for a 20-point drop from the pooled '
              'rate.', '',
              '### Trials and host load', '',
              '| Arm | Trial | Status | Wall seconds | Load start | Load mean | Load max | Load end | Outlived credentials |',
              '|---|---:|---|---:|---:|---:|---:|---:|---|']
    for record in records:
        load = record.get('load') or {}
        status = record.get('status') or record.get('calibration_error') or 'no result'
        lines.append(f'| {record["arm"]} | {record["trial"]} | {status} | {record["seconds"]} | '
                     f'{number(record["load_start"])} | {number(load.get("mean"))} | {number(load.get("max"))} | '
                     f'{number(record["load_end"])} | {"yes" if record.get("outlived_credentials") else "no"} |')
    lines += ['', f'Load is the host 1-minute load average sampled every {LOAD_INTERVAL} s; compare it with '
              f'{config["cpus"]} CPUs. Trials that outlived their exported credentials can fail late phases for '
              'that reason alone, so they count as infrastructure errors and are excluded from rates and power '
              'estimates; their raw results stay in the run directories.']
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--trials', type=parse_trials, required=True, help='trials per arm (1-50)')
    parser.add_argument('--concurrency', type=int, default=2,
                        help='concurrent Harbor runs; each container takes 2 CPUs and 6 GiB (default 2)')
    parser.add_argument('--output', type=Path, required=True, help='new or empty calibration directory')
    parser.add_argument('--revision', default='HEAD', help='AWS Blocks revision to pack once (default HEAD)')
    parser.add_argument('--registry', type=Path,
                        help='reuse an already packed dist-registry of --revision instead of building it')
    parser.add_argument('--profile', default=os.environ.get('HARBOR_AWS_PROFILE'),
                        help='AWS profile with temporary credentials and Bedrock access to the pinned model '
                             '(default: $HARBOR_AWS_PROFILE). The coding agent receives these credentials.')
    parser.add_argument('--dry-run', action='store_true',
                        help='prepare work dirs and print the plan; no image build, credentials or model calls')
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error('--concurrency must be at least 1')
    if not args.dry_run:
        if not args.profile:
            parser.error('--profile (or HARBOR_AWS_PROFILE) is required unless --dry-run')
        for tool in ('harbor', 'docker', 'aws'):
            if not shutil.which(tool):
                parser.error(f'{tool} is not on PATH (see README: Local calibration)')
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error(f'{output} is not empty')
    output.mkdir(parents=True, exist_ok=True)

    commit = git('rev-parse', '--verify', f'{args.revision}^{{commit}}')
    identity = None
    if not args.dry_run:
        # Fail before packing if the profile cannot sign in; show whose permissions the agent will hold.
        identity = caller_arn(args.profile)
        print(f'Trials run as {identity} (profile {args.profile}); the coding agent receives these credentials.',
              file=sys.stderr, flush=True)
    config = {
        'revision': args.revision, 'commit': commit, 'harness_commit': git('rev-parse', 'HEAD'),
        'harness_dirty': bool(git('status', '--porcelain', '--', 'scripts/harbor-bench')),
        'trials': args.trials, 'concurrency': args.concurrency, 'cpus': os.cpu_count(),
        'design': 'A/A: baseline and candidate install the same packed packages',
        'credentials': 'fresh credentials exported from the profile before each trial',
        'profile': args.profile, 'caller_arn': identity, 'started_at': now().isoformat(),
    }
    registry = args.registry.resolve() if args.registry else build_and_pack(commit, output)
    config['registry'] = str(registry)
    order = [(arm, trial) for trial in range(1, args.trials + 1) for arm in ARMS]  # Interleaved arms.
    for arm, trial in order:
        prepare(registry, output / 'runs' / f'{arm}-{trial}', arm, commit, config['harness_commit'])
    images = sorted({json.loads((output / 'runs' / f'{arm}-1' / 'identity.json').read_text())['image'] for arm in ARMS})
    config['images'] = images
    plan = dict(config, work_dirs=[f'runs/{arm}-{trial}' for arm, trial in order],
                image_context='runs/baseline-1/task/environment', dry_run=args.dry_run)
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps(plan, indent=2), flush=True)
    if args.dry_run:
        return 0

    # Every work dir holds the same Dockerfile, registry and bench files: one build, both tags.
    subprocess.run(['docker', 'build', *[part for image in images for part in ('--tag', image)],
                    str(output / 'runs' / 'baseline-1' / 'task' / 'environment')], check=True)
    sampler = LoadSampler()
    sampler.start()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        records = list(pool.map(lambda item: run_trial(args, output, sampler, *item), order))
    sampler.done.set()
    config['finished_at'] = now().isoformat()

    os.environ.update(BASELINE_SHA=commit, CANDIDATE_SHA=commit, HARNESS_SHA=config['harness_commit'])
    os.environ.pop('RUN_URL', None)
    arms = load_trials(output / 'results', args.trials)
    summary = aggregate(arms)
    extra = calibration(arms, summary)
    report = render(output / 'results', args.trials)
    (output / 'summary.json').write_text(json.dumps(
        {'config': config, 'trials': records, 'aggregate': summary, 'calibration': extra}, indent=2) + '\n')
    (output / 'summary.md').write_text(render_summary(config, records, report, extra))
    print(f'wrote {output / "summary.md"} and {output / "summary.json"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
