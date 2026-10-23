"""Multi-trial, trace and snapshot regression tests; no paid model calls, AWS or Docker."""
import argparse
import gzip
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest

from accounting import summarize
from public_result import collect, storage
from report import aggregate, load_trials, render
from stats import (bootstrap_median_difference, cv, median_change_power, median_iqr, trials_for_median_change,
                   trials_for_rate_drop, wilson)
from traces import pack, s3_prefix, secrets_from_env, upload_policy
from trials import matrix, parse_trials

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'task/tests'))
sys.dont_write_bytecode = True  # task/ is copied into every task and mounted into containers.
from snapshot import capture  # noqa: E402
sys.dont_write_bytecode = False

SECRETS = {'AWS_ACCESS_KEY_ID': 'ASIAEXAMPLEKEY123456',
           'AWS_SECRET_ACCESS_KEY': 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
           'AWS_SESSION_TOKEN': 'IQoJb3JpZ2luX2VjEXAMPLE/session+token=='}
CHECKS = ('package_provenance', 'build', 'all_phases_and_reload', 'blocks_persistence',
          'server_restart_fresh_browser')


class TrialsInputTests(unittest.TestCase):
    def test_accepts_one_to_fifty(self):
        self.assertEqual(parse_trials('1'), 1)
        self.assertEqual(parse_trials('50'), 50)
        self.assertEqual(matrix('3'), [1, 2, 3])

    def test_rejects_everything_else(self):
        for value in ('0', '51', '100', '01', '-1', '+2', ' 3', '3 ', '3.0', '1e1', 'three', '', None):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                parse_trials(value)

    def test_cli_prints_matrix_or_fails_without_output(self):
        script = str(ROOT / 'trials.py')
        ok = subprocess.run([sys.executable, script, '2'], capture_output=True, text=True)
        self.assertEqual((ok.returncode, json.loads(ok.stdout)), (0, [1, 2]))
        bad = subprocess.run([sys.executable, script, '51'], capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(bad.stdout, '')

    def test_workflow_uses_validated_matrix_and_per_trial_names(self):
        workflow = (ROOT.parents[1] / '.github/workflows/harbor-agent-check.yml').read_text()
        self.assertIn('trial: ${{ fromJSON(needs.revisions.outputs.trials) }}', workflow)
        self.assertIn('name: harbor-result-${{ matrix.arm }}-${{ matrix.trial }}', workflow)
        self.assertIn('WORK: run-${{ matrix.arm }}-${{ matrix.trial }}', workflow)
        self.assertNotIn('blocks-harbor-traces', workflow)  # The bucket comes from an environment variable.


def members(data):
    """Every (name, bytes) in a gzip tarball, descending into nested tarballs."""
    found = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if not member.isfile():
                found[member.name] = None
                continue
            content = archive.extractfile(member).read()
            found[member.name] = content
            if member.name.endswith('.tar.gz'):
                found.update({f'{member.name}!{name}': value for name, value in members(content).items()})
    return found


class TraceTests(unittest.TestCase):
    def test_redacts_exact_values_in_every_file_and_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp) / 'run'
            agent = work / 'jobs/baseline/trial/steps/create/agent'
            verifier = work / 'jobs/baseline/trial/steps/create/verifier'
            agent.mkdir(parents=True)
            verifier.mkdir(parents=True)
            (work / 'public').mkdir()
            (work / 'task/environment').mkdir(parents=True)
            key, secret, token = SECRETS.values()
            (work / 'harbor.log').write_text(f'env AWS_ACCESS_KEY_ID={key}\nsecret={secret} again {secret}\n')
            (agent / 'claude-code.txt').write_text(json.dumps({'output': f'export AWS_SESSION_TOKEN={token}'}))
            binary = b'\x00\xff\x89PNG' + token.encode() + b'\x00\x01'
            (agent / 'blob.bin').write_bytes(binary)
            clean = bytes(range(256)) * 4
            (agent / 'clean.bin').write_bytes(clean)
            (work / 'public/result.json').write_text('{"status": "passed"}')
            (work / 'task/environment/Dockerfile').write_text(secret)  # Not part of the trace.
            os.symlink('/etc/passwd', agent / 'link')
            snapshot = io.BytesIO()
            with tarfile.open(fileobj=snapshot, mode='w:gz') as archive:
                content = f'AWS_SECRET_ACCESS_KEY={secret}\n'.encode()
                info = tarfile.TarInfo('todo-app/.env')
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            (verifier / 'snapshot.tar.gz').write_bytes(snapshot.getvalue())
            (verifier / 'broken.tgz').write_bytes(b'not gzip ' + key.encode())

            output = Path(temp) / 'traces' / 'baseline-1.tar.gz'  # Directory not created yet, as in calibrate.py.
            summary = pack(work, output, SECRETS)
            data = output.read_bytes()
            found = members(data)
            everything = b''.join(value for value in found.values() if value) + ''.join(found).encode()
            for value in SECRETS.values():
                self.assertNotIn(value.encode(), everything)
                self.assertNotIn(value.encode(), gzip.decompress(data))
            self.assertIn(b'[REDACTED:AWS_SECRET_ACCESS_KEY] again [REDACTED:AWS_SECRET_ACCESS_KEY]',
                          found['harbor.log'])
            self.assertEqual(found['jobs/baseline/trial/steps/create/agent/blob.bin'],
                             b'\x00\xff\x89PNG[REDACTED:AWS_SESSION_TOKEN]\x00\x01')
            self.assertEqual(found['jobs/baseline/trial/steps/create/agent/clean.bin'], clean)
            self.assertEqual(found['jobs/baseline/trial/steps/create/verifier/snapshot.tar.gz!todo-app/.env'],
                             b'AWS_SECRET_ACCESS_KEY=[REDACTED:AWS_SECRET_ACCESS_KEY]\n')
            self.assertIn(b'[REDACTED:AWS_ACCESS_KEY_ID]', found['jobs/baseline/trial/steps/create/verifier/broken.tgz'])
            self.assertIn('public/result.json', found)
            self.assertFalse(any(name.startswith('task') for name in found))
            self.assertNotIn('jobs/baseline/trial/steps/create/agent/link', found)
            self.assertEqual(summary['redactions'], {'AWS_ACCESS_KEY_ID': 2, 'AWS_SECRET_ACCESS_KEY': 3,
                                                     'AWS_SESSION_TOKEN': 2})
            self.assertEqual(summary['skipped_links'], 1)
            self.assertEqual(json.loads(found['redaction.json'])['redactions'], summary['redactions'])

    def test_credentials_come_from_named_env_vars_only(self):
        self.assertEqual(secrets_from_env({'AWS_ACCESS_KEY_ID': 'a' * 20, 'AWS_SESSION_TOKEN': '', 'OTHER': 'x'}),
                         {'AWS_ACCESS_KEY_ID': 'a' * 20})

    def test_s3_prefix_layout_and_validation(self):
        self.assertEqual(s3_prefix('123', '987654321', '2', 'candidate', '7'),
                         'harbor/v1/pr=123/run=987654321/attempt=2/arm=candidate/trial=7/')
        for args in (('0', '1', '1', 'baseline', '1'), ('1', '1', '1', 'other', '1'),
                     ('1', '1', '1', 'baseline', '51'), ('1', '../x', '1', 'baseline', '1'),
                     ('1', '1', '', 'baseline', '1')):
            with self.subTest(args=args), self.assertRaises(ValueError):
                s3_prefix(*args)

    def test_upload_policy_confines_session_to_its_trial_prefix(self):
        prefix = s3_prefix('885', '39443725469', '3', 'candidate', '2')
        policy = json.loads(upload_policy('example-traces', prefix))
        self.assertEqual(policy['Statement'], [{
            'Effect': 'Allow', 'Action': 's3:PutObject',
            'Resource': 'arn:aws:s3:::example-traces/harbor/v1/pr=885/run=39443725469/attempt=3/arm=candidate/trial=2/*'}])
        for bucket, key in (('Bad_Bucket', prefix), ('example-traces', 'harbor/v1/'),
                            ('example-traces', 'harbor/v1/pr=1/run=1/attempt=1/arm=x/trial=1/../')):
            with self.subTest(bucket=bucket, key=key), self.assertRaises(ValueError):
                upload_policy(bucket, key)


class StatsTests(unittest.TestCase):
    def test_wilson_interval(self):
        self.assertIsNone(wilson(0, 0))
        low, high = wilson(5, 10)
        self.assertAlmostEqual(low, 0.2366, places=4)
        self.assertAlmostEqual(high, 0.7634, places=4)
        low, high = wilson(10, 10)
        self.assertAlmostEqual(low, 0.7225, places=4)
        self.assertEqual(high, 1.0)
        self.assertEqual(wilson(0, 10)[0], 0.0)

    def test_median_and_iqr(self):
        self.assertIsNone(median_iqr([]))
        self.assertEqual(median_iqr([7]), (7, 7, 7))
        self.assertEqual(median_iqr([5, 1, 4, 2, 3]), (3, 2, 4))
        self.assertEqual(median_iqr([1, 2, 3, 4]), (2.5, 1.75, 3.25))

    def test_bootstrap_is_seeded_and_needs_three_per_arm(self):
        baseline, candidate = [10, 12, 11, 13, 9], [15, 14, 16, 18, 13]
        first = bootstrap_median_difference(baseline, candidate)
        self.assertEqual(first, bootstrap_median_difference(baseline, candidate))
        self.assertEqual(first['difference'], 4)
        self.assertLessEqual(first['low'], first['difference'])
        self.assertGreaterEqual(first['high'], first['difference'])
        self.assertNotEqual(first, bootstrap_median_difference(baseline, candidate, seed=1, resamples=50))
        self.assertIsNone(bootstrap_median_difference([1, 2], [1, 2, 3]))
        self.assertIsNone(bootstrap_median_difference([1, 2, 3], [1, 2]))

    def test_variation_and_power(self):
        self.assertIsNone(cv([3]))
        self.assertAlmostEqual(cv([2, 4]), 2 ** 0.5 / 3)
        self.assertEqual(trials_for_rate_drop(1.0, 0.2), 35)
        self.assertIsNone(trials_for_rate_drop(0.1, 0.2))

    def test_median_power_uses_the_reports_bootstrap_rule(self):
        # Without spread any shift is detected at the smallest comparable size.
        self.assertEqual(trials_for_median_change([40] * 8, 0.1), 3)
        # Too small a pilot, or no signal, gives no estimate.
        self.assertIsNone(trials_for_median_change([40] * 5, 0.1))
        self.assertIsNone(trials_for_median_change([0] * 8, 0.1))
        # A skewed pilot with an outlier: larger changes need fewer trials, and no change is rarely "detected".
        pilot = [100, 104, 108, 111, 115, 120, 126, 135, 150, 400]
        needs = [trials_for_median_change(pilot, change, simulations=80, resamples=100) for change in (0.1, 0.2, 0.3)]
        self.assertEqual(needs, sorted(needs, reverse=True))
        self.assertGreater(needs[0], needs[2])
        self.assertLess(median_change_power(pilot, 0.0, 20), 0.15)
        self.assertEqual(median_change_power(pilot, 0.2, 10), median_change_power(pilot, 0.2, 10))


def result(arm, statuses, tokens=100, seconds=60, storage='kv_store'):
    phases = []
    for name, status in zip(('create', 'due-dates', 'labels'), statuses):
        phase = {'name': name, 'status': status}
        if status != 'not_run':
            phase.update(accounting_complete=True, skill_use='none', turns=3, tool_calls=5,
                         duration_ms=seconds * 1000,
                         usage={'input_tokens': tokens, 'cache_write_tokens': 10, 'cache_read_tokens': 1000,
                                'output_tokens': 50, 'input_processed_tokens': tokens + 1010, 'cost_usd': 0.25,
                                'cache_neutral_cost_usd': tokens / 1000})
        if status == 'failed':
            phase['failure'] = {'stage': 'ui_exercise', 'check': 'normalize_labels', 'kind': 'assertion',
                                'reason': 'locator_ambiguous'}
        phases.append(phase)
    return {'arm': arm, 'harbor_exit_code': 0, 'same_session': True, 'phases': phases, 'storage': storage,
            'status': 'passed' if all(s == 'passed' for s in statuses) else 'failed',
            'packages': [{'name': '@aws-blocks/core', 'integrity': 'sha512-x'}]}


def write(root, arm, trial, value):
    directory = root / f'harbor-result-{arm}-{trial}'
    directory.mkdir(parents=True)
    (directory / 'result.json').write_text(json.dumps(value))


class MultiTrialReportTests(unittest.TestCase):
    def test_rates_medians_differences_and_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for trial in range(1, 6):
                write(root, 'baseline', trial, result('baseline', ['passed'] * 3, tokens=100 + trial))
            for trial in range(1, 5):
                labels = 'passed' if trial <= 2 else 'failed'
                write(root, 'candidate', trial, result('candidate', ['passed', 'passed', labels], tokens=200 + trial,
                                                       storage='kv_store' if trial <= 2 else 'distributed_table'))
            write(root, 'candidate', 6, {'status': 'infrastructure_error', 'phases': []})
            arms = load_trials(root, 6)
            self.assertIsNone(arms['candidate'][5])
            summary = aggregate(arms)
            self.assertEqual(summary['arms']['candidate']['missing'], [5])
            self.assertEqual(summary['arms']['candidate']['infrastructure_error'], [6])
            self.assertEqual(summary['arms']['baseline']['missing'], [6])
            labels = summary['arms']['candidate']['phases']['labels']
            self.assertEqual((labels['passes'], labels['n']), (2, 4))
            self.assertEqual(summary['arms']['baseline']['phases']['create']['metrics']['new_input']['median'], 113)
            create = summary['differences']['create']['input_processed_tokens']
            self.assertTrue(create['comparable'])
            self.assertEqual(create['difference'], 99.5)
            self.assertFalse(summary['differences']['labels']['input_processed_tokens']['comparable'])
            self.assertFalse(summary['differences']['total']['turns']['comparable'])
            # New input and cache read are descriptive: summarized per arm, never compared.
            self.assertNotIn('new_input', summary['differences']['create'])
            self.assertNotIn('cache_read_tokens', summary['differences']['create'])

            text = render(root, 6)
            self.assertIn('6 todo-app trajectories per arm', text)
            self.assertIn('| create | 5/5 (100%; 57–100%) | 4/4 (100%; 51–100%) | none 5 | none 4 |', text)
            self.assertIn('| labels | 5/5 (100%; 57–100%) | 2/4 (50%; 15–85%) |', text)
            self.assertIn('not comparable (2 passes)', text)
            # The primary metric is the first compared column.
            self.assertIn('| Phase | Cache-neutral cost (primary) Δ | Input processed Δ |', text)
            self.assertIn('| create | +$0.0995 (+96.6%) [', text)
            self.assertIn('| +99.5 (+8.9%) [', text)
            self.assertIn('| List-price cost | New input† | Cache read† |', text)
            self.assertIn('**candidate trial 3 / labels**: ui_exercise, assertion (locator_ambiguous).', text)
            self.assertIn('| kv_store | 5 | 2 | $0.3090 (5 passed) |', text)
            self.assertIn('| distributed_table | 0 | 2 | — | — | not comparable (0 passes) |', text)
            self.assertIn('1 without result (trial 5); 1 infrastructure error (trial 6), excluded', text)
            self.assertIn('| 5 | passed | NO RESULT |', text)
            self.assertIn('A/A infrastructure demonstration', text)
            self.assertNotIn('n=1', text)
            # Without --trials, the largest trial found sets N.
            self.assertEqual(len(load_trials(root)['baseline']), 6)

    def test_storage_strata_compare_within_one_storage_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for trial, (tokens, storage) in enumerate([(100, 'kv_store'), (110, 'kv_store'), (120, 'kv_store'),
                                                       (300, 'distributed_table')], 1):
                write(root, 'baseline', trial, result('baseline', ['passed'] * 3, tokens=tokens, storage=storage))
            for trial, (tokens, storage) in enumerate([(130, 'kv_store'), (140, 'kv_store'), (150, 'kv_store'),
                                                       (300, 'multiple'), (300, 'SECRET')], 1):
                write(root, 'candidate', trial, result('candidate', ['passed'] * 3, tokens=tokens, storage=storage))
            summary = aggregate(load_trials(root, 5))
            self.assertEqual(list(summary['storage']), ['kv_store', 'distributed_table', 'multiple', 'unknown'])
            kv = summary['storage']['kv_store']
            self.assertEqual((kv['baseline']['passes'], kv['candidate']['passes']), (3, 3))
            self.assertTrue(kv['difference']['comparable'])
            self.assertAlmostEqual(kv['difference']['difference'], 0.09)
            self.assertFalse(summary['storage']['distributed_table']['difference']['comparable'])
            text = render(root, 5)
            self.assertIn('| kv_store | 3 | 3 | $0.3300 (3 passed) | $0.4200 (3 passed) | +$0.0900 (+27.3%) [', text)
            self.assertIn('| distributed_table | 1 | 0 | $0.9000 (1 passed) | — | not comparable (0 passes) |', text)
            self.assertIn('| unknown | 0 | 1 |', text)
            self.assertNotIn('SECRET', text)

    def test_single_trial_makes_no_interval_claims(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write(root, 'baseline', 1, result('baseline', ['passed'] * 3))
            write(root, 'candidate', 1, result('candidate', ['passed', 'failed', 'not_run'],
                                               storage='distributed_table'))
            text = render(root, 1)
            self.assertIn('**n=1, not a statistical performance claim**', text)
            self.assertIn('| create | passed, skill: none | passed, skill: none | yes (n=1) |', text)
            self.assertIn('| due-dates | passed, skill: none | failed, skill: none | no |', text)
            self.assertIn('**candidate / due-dates**', text)
            self.assertIn('- **baseline: passed**; session continuity verified; storage: kv_store.', text)
            self.assertIn('The arms built on different storage blocks', text)
            self.assertIn('| Phase | Baseline | Candidate | Comparable | Cache-neutral cost (primary) Δ |', text)
            for claim in ('Wilson', '95%', 'bootstrap', 'IQR', '### Storage block'):
                self.assertNotIn(claim, text)

    def test_untrusted_strings_never_render(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bad = result('baseline', ['passed'] * 3)
            bad['status'] = '<script>'
            bad['phases'][0]['failure'] = {'stage': 'SECRET', 'kind': 'SECRET'}
            bad['phases'][1].update(status='failed', failure={'stage': 'ui_exercise', 'kind': 'assertion',
                                                              'reason': 'SECRET'})
            bad['storage'] = 'SECRET'
            for trial in (1, 2):
                write(root, 'baseline', trial, bad)
            (root / 'harbor-result-baseline-x').mkdir()
            text = render(root, 2)
            self.assertNotIn('<script>', text)
            self.assertNotIn('SECRET', text)


class CalibrationSummaryTests(unittest.TestCase):
    def test_cv_power_rates_and_load_render(self):
        from calibrate import calibration, render_summary
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for trial in range(1, 5):
                for arm, tokens in (('baseline', 100 + 10 * trial), ('candidate', 105 + 10 * trial)):
                    write(root, arm, trial, result(arm, ['passed'] * 3, tokens=tokens))
            arms = load_trials(root, 4)
            summary = aggregate(arms)
            extra = calibration(arms, summary, simulations=20, resamples=50)
            self.assertEqual(extra['pass_rates']['labels']['rate'], 1.0)
            self.assertEqual(extra['pass_rates']['labels']['trials_per_arm_for_rate_drop'], 35)
            create = extra['cv']['create']['new_input']
            self.assertEqual(create['pooled_n'], 8)
            self.assertAlmostEqual(create['pooled_cv'], cv([100 + 10 * t + d + 10 for t in range(1, 5) for d in (0, 5)]))
            self.assertEqual(extra['cv']['create']['turns']['pooled_cv'], 0)
            self.assertEqual(extra['trials_per_arm_80_power']['create']['turns'], {'10%': 'n/a', '20%': 'n/a', '30%': 'n/a'})
            self.assertIsInstance(extra['trials_per_arm_80_power']['create']['cost_usd']['10%'], (int, type(None)))
            # The primary metric is a cost, not a count: it gets CV and power estimates.
            neutral = extra['cv']['create']['cache_neutral_cost_usd']
            self.assertEqual(neutral['pooled_n'], 8)
            self.assertAlmostEqual(neutral['pooled_cv'], cv([(100 + 10 * t + d) / 1000 for t in range(1, 5) for d in (0, 5)]))
            self.assertTrue(all(isinstance(need, (int, type(None))) for need in
                                extra['trials_per_arm_80_power']['create']['cache_neutral_cost_usd'].values()))
            self.assertEqual(extra['cv']['create']['input_processed_tokens']['pooled_n'], 8)
            config = {'commit': 'a' * 40, 'harness_commit': 'b' * 40, 'harness_dirty': False, 'trials': 4,
                      'concurrency': 2, 'cpus': 8, 'started_at': 's', 'finished_at': 'f'}
            records = [{'arm': 'baseline', 'trial': 1, 'status': 'passed', 'seconds': 10.0, 'load_start': 1.0,
                        'load_end': 2.0, 'load': {'mean': 1.5, 'max': 3.0}, 'outlived_credentials': False}]
            text = render_summary(config, records, render(root, 4), extra)
            self.assertIn('## Aggregate report', text)
            self.assertIn('| labels | 8/8 | 100% (68–100%) | 35 |', text)
            self.assertIn('| baseline | 1 | passed | 10.0 | 1.00 | 1.50 | 3.00 | 2.00 | no |', text)
            self.assertIn('| create | Cache-neutral cost (primary) | 0.10 | 0.10 |', text)
            self.assertIn('| total | Input processed |', text)
            self.assertIn('| create | Cache read† |', text)

    def test_trials_that_outlived_credentials_are_excluded_but_kept_raw(self):
        from calibrate import calibration, collect_result
        from report import TOTAL
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for trial in range(1, 4):
                for arm in ('baseline', 'candidate'):
                    # Both trial 3s outlived their credentials: baseline failed late, candidate passed everything.
                    outlived = trial == 3
                    work = root / 'runs' / f'{arm}-{trial}'
                    (work / 'public').mkdir(parents=True)
                    late_failure = outlived and arm == 'baseline'
                    raw = result(arm, ['passed', 'failed', 'not_run'] if late_failure else ['passed'] * 3)
                    (work / 'public' / 'result.json').write_text(json.dumps(raw))
                    record = {'arm': arm, 'trial': trial, 'outlived_credentials': outlived}
                    collect_result(work, root, record)
                    self.assertEqual(record['status'], raw['status'])
                    self.assertEqual(record.get('excluded'), 'outlived_credentials' if outlived else None)
            arms = load_trials(root / 'results', 3)
            summary = aggregate(arms)
            baseline = summary['arms']['baseline']
            self.assertEqual(baseline['infrastructure_error'], [3])
            self.assertEqual(summary['arms']['candidate']['infrastructure_error'], [3])
            self.assertEqual((baseline['phases'][TOTAL]['passes'], baseline['phases'][TOTAL]['n']), (2, 2))
            extra = calibration(arms, summary, simulations=20, resamples=50)
            self.assertEqual(extra['pass_rates']['due-dates']['rate'], 1.0)
            # Excluded trials stay out of pooled variation even for phases they passed.
            self.assertEqual(extra['cv']['create']['new_input']['pooled_n'], 4)
            raw = json.loads((root / 'runs' / 'baseline-3' / 'public' / 'result.json').read_text())
            self.assertEqual(raw['status'], 'failed')


class SnapshotTests(unittest.TestCase):
    def test_snapshot_excludes_node_modules_and_keeps_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / 'todo-app'
            for path in ('node_modules/pkg', 'aws-blocks/node_modules/nested', '.bb-data/app-todos', 'src'):
                (app / path).mkdir(parents=True)
            (app / 'node_modules/pkg/index.js').write_text('x')
            (app / 'aws-blocks/node_modules/nested/index.js').write_text('x')
            (app / '.bb-data/app-todos/store.json').write_text('{"1": {"title": "survival-a"}}')
            (app / 'package-lock.json').write_text('{}')
            (app / 'src/index.ts').write_text('export {}')
            os.symlink('../package-lock.json', app / 'src/lock')
            server = socket.socket(socket.AF_UNIX)
            server.bind(str(app / 'dev.sock'))
            state = root / 'state.json'
            state.write_text('{"items": [{"title": "survival-a"}]}')
            target = root / 'snapshot.tar.gz'
            capture(app, state, target)
            server.close()
            with tarfile.open(target) as archive:
                names = set(archive.getnames())
                self.assertEqual(archive.extractfile('verifier-state.json').read(), state.read_bytes())
            self.assertEqual(names, {'todo-app', 'todo-app/.bb-data', 'todo-app/.bb-data/app-todos',
                                     'todo-app/.bb-data/app-todos/store.json', 'todo-app/aws-blocks',
                                     'todo-app/package-lock.json', 'todo-app/src', 'todo-app/src/index.ts',
                                     'todo-app/src/lock', 'verifier-state.json'})
            self.assertFalse((root / 'snapshot.tar.gz.partial').exists())

    def test_public_result_never_publishes_snapshots_or_raw_logs(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            (work / 'public').mkdir()
            trial = work / 'jobs/baseline/trial'
            steps = []
            for name in ('create', 'due-dates', 'labels'):
                metrics = summarize('')
                steps.append({'step_name': name, 'agent_result': {'metadata': {'harbor_bench': metrics}}})
                verifier = trial / 'steps' / name / 'verifier'
                verifier.mkdir(parents=True)
                (verifier / 'verification.json').write_text(json.dumps(
                    {'status': 'passed', 'snapshot': True, 'checks': {key: True for key in CHECKS}}))
                (verifier / 'snapshot.tar.gz').write_bytes(b'snapshot-bytes')
                (verifier / 'server.log').write_text('raw-log')
            (trial / 'result.json').write_text(json.dumps({'step_results': steps}))
            identity = {'arm': 'baseline', 'commit': 'a' * 40, 'skill_revision': 'b' * 40, 'packages': []}
            value = collect(work, identity, 0, None)
            self.assertEqual(value['storage'], 'unknown')  # The snapshot is not a readable tarball.
            names = {path.name for path in (work / 'public').iterdir()}
            self.assertEqual(names, {f'{name}-tools.json' for name in ('create', 'due-dates', 'labels')})
            published = json.dumps(value) + ''.join(p.read_text() for p in (work / 'public').iterdir())
            for private in ('snapshot', 'raw-log'):
                self.assertNotIn(private, published)


def tarball(path, files):
    with tarfile.open(path, 'w:gz') as archive:
        for name, text in files.items():
            content = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))


class PublicResultTests(unittest.TestCase):
    def test_storage_is_a_fixed_name_from_constructed_backend_blocks(self):
        backend = 'todo-app/aws-blocks/index.ts'
        cases = {
            'kv_store': {backend: 'const todos = new KVStore<Todo>(scope, "todos");'},
            'distributed_table': {'todo-app/aws-blocks/lib/store.ts': 'new DistributedTable<Todo>(this, "t", {})'},
            'database': {backend: 'const db = new Database(scope, "db");'},
            'distributed_database': {backend: 'const db = new  DistributedDatabase(scope, "db");'},
            'file_bucket': {backend: 'const files = new FileBucket(scope, "files");'},
            'multiple': {backend: 'new KVStore(scope, "a")', 'todo-app/aws-blocks/files.ts': 'new FileBucket(s, "f")'},
            # Imports and types are not use; generated JS, dependencies and frontend code are not the backend.
            'none': {backend: 'import { KVStore } from "@aws-blocks/blocks";\ntype Store = KVStore<string>;',
                     'todo-app/aws-blocks/index.js': 'new Database(scope, "db")',
                     'todo-app/aws-blocks/node_modules/x/index.ts': 'new KVStore(scope, "x")',
                     'todo-app/src/main.ts': 'new FileBucket(scope, "f")'},
        }
        with tempfile.TemporaryDirectory() as temp:
            for expected, files in cases.items():
                path = Path(temp) / f'{expected}.tar.gz'
                tarball(path, files)
                with self.subTest(storage=expected):
                    self.assertEqual(storage(path), expected)
            corrupt = Path(temp) / 'corrupt.tar.gz'
            corrupt.write_bytes(b'not a tarball')
            self.assertEqual(storage(corrupt), 'unknown')
            self.assertEqual(storage(Path(temp) / 'missing.tar.gz'), 'unknown')

    def test_result_carries_storage_and_only_allowlisted_failure_reasons(self):
        for reason, published in (('prior_due', 'prior_due'), ('title was "private-title"', None)):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temp:
                work = Path(temp)
                (work / 'public').mkdir()
                trial = work / 'jobs/baseline/trial'
                verifier = trial / 'steps/create/verifier'
                verifier.mkdir(parents=True)
                (verifier / 'verification.json').write_text(json.dumps(
                    {'status': 'failed', 'failure': {'stage': 'ui_exercise', 'kind': 'runtime'}}))
                (verifier / 'ui-exercise.json').write_text(json.dumps(
                    {'status': 'failed', 'failure': {'kind': 'timeout', 'reason': reason}}))
                tarball(verifier / 'snapshot.tar.gz',
                        {'todo-app/aws-blocks/index.ts': 'export const todos = new DistributedTable(scope, "t");'})
                (trial / 'result.json').write_text(json.dumps({'step_results': [
                    {'step_name': 'create', 'agent_result': {'metadata': {'harbor_bench': summarize('')}}}]}))
                identity = {'arm': 'baseline', 'commit': 'a' * 40, 'skill_revision': 'b' * 40, 'packages': []}
                value = collect(work, identity, 1, None)
                self.assertEqual(value['storage'], 'distributed_table')
                failure = value['phases'][0]['failure']
                self.assertEqual(failure.get('reason'), published)
                self.assertEqual(failure['kind'], 'timeout')
                self.assertNotIn('private-title', json.dumps(value))
                self.assertEqual(value['phases'][0]['usage']['cache_neutral_cost_usd'], None)


if __name__ == '__main__':
    unittest.main()
