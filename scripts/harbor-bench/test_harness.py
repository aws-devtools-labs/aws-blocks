"""Credential-free harness regression tests; no paid model calls or Docker required."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from accounting import summarize
from provenance import verify
from public_result import collect
from report import difference, eligible_pair, render

MODEL = 'global.anthropic.claude-opus-5-5'


def stream(values, session='session-a', turns=3, duplicate=False):
    assistant = {'type': 'assistant', 'message': {'id': 'message-1', 'content': [
        {'type': 'tool_use', 'id': 'tool-1', 'name': 'Bash', 'input': {'command': 'private-string'}}]}}
    events = [assistant, assistant] if duplicate else [assistant]
    events.append({'type': 'system', 'subtype': 'init', 'model': MODEL})
    events.append({'type': 'result', 'session_id': session, 'is_error': False,
                   'subtype': 'success', 'num_turns': turns, 'total_cost_usd': values[4],
                   'modelUsage': {MODEL: dict(zip(('inputTokens', 'cacheReadInputTokens',
                                                  'cacheCreationInputTokens', 'outputTokens'), values))}})
    return '\n'.join(json.dumps(event) for event in events)


class AccountingTests(unittest.TestCase):
    def test_cumulative_three_phase_deltas_and_invocation_turns(self):
        previous = None
        metrics = []
        for values, turns in [([10, 20, 30, 40, 1.0], 5), ([15, 40, 35, 50, 1.5], 2), ([20, 70, 40, 65, 2.0], 3)]:
            previous = summarize(stream(values, turns=turns, duplicate=True), previous)
            metrics.append(previous)
        self.assertEqual([m['turns'] for m in metrics], [5, 2, 3])
        self.assertEqual([m['usage']['input_tokens'] for m in metrics], [10, 5, 5])
        self.assertEqual([m['usage']['cache_read_tokens'] for m in metrics], [20, 20, 30])
        self.assertEqual([m['usage']['cache_write_tokens'] for m in metrics], [30, 5, 5])
        self.assertEqual(sum(m['usage']['output_tokens'] for m in metrics), 65)
        self.assertEqual(sum(m['usage']['cost_usd'] for m in metrics), 2.0)
        self.assertEqual([m['tool_calls'] for m in metrics], [1, 1, 1])
        self.assertEqual([m['llm_calls'] for m in metrics], [1, 1, 1])
        self.assertTrue(all(not m['accounting_errors'] for m in metrics))

    def test_missing_reset_or_decreasing_usage_is_not_zero(self):
        first = summarize(stream([10, 20, 30, 40, 1.0]))
        self.assertIsNone(summarize('', first)['usage']['input_tokens'])
        self.assertIn('session_changed', summarize(stream([20, 30, 40, 50, 2.0], session='new'), first)['accounting_errors'])
        bad = summarize(stream([5, 20, 30, 40, 1.0]), first)
        self.assertIsNone(bad['usage']['input_tokens'])
        self.assertIn('nonmonotonic_input_tokens', bad['accounting_errors'])


class ProvenanceTests(unittest.TestCase):
    def test_real_tarball_bytes_lock_origin_and_scaffolder_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            registry, app = root / 'registry', root / 'app'
            registry.mkdir()
            manifest, served = [], []
            for project, names in [('bootstrap', ['create-blocks-app']), ('todo-app', ['blocks', 'core'])]:
                entries = {}
                for short in names:
                    name = '@aws-blocks/' + short
                    key = f'registry/{name}/-/{short}-1.0.0.tgz'
                    tarball = registry / key
                    tarball.parent.mkdir(parents=True)
                    content = json.dumps({'name': name, 'version': '1.0.0'}).encode()
                    with tarfile.open(tarball, 'w:gz') as archive:
                        member = tarfile.TarInfo('package/package.json')
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                    info = {'name': name, 'version': '1.0.0', 'integrity': 'sha512-test', 'tarballS3Key': key}
                    manifest.append(info)
                    location = f'node_modules/{name}'
                    directory = app / project / location
                    directory.mkdir(parents=True)
                    (directory / 'package.json').write_bytes(content)
                    entries[location] = {'version': '1.0.0', 'integrity': 'sha512-test', 'resolved': 'http://localhost:4873/' + key}
                    served.append(json.dumps({'path': '/' + key}))
                entries['node_modules/@aws-blocks/core/node_modules/zod'] = {'version': '3.0.0'}
                (app / project / 'package-lock.json').write_text(json.dumps({'packages': entries}))
            (registry / 'publish-manifest.json').write_text(json.dumps({'packages': manifest}))
            backend = app / 'todo-app/aws-blocks'
            backend.mkdir()
            (backend / 'index.ts').write_text('import { ApiNamespace, KVStore } from "@aws-blocks/blocks";')
            ledger = root / 'ledger.jsonl'
            ledger.write_text('\n'.join(served))
            self.assertEqual(len(verify(registry, app, ledger)['packages']), 3)
            lock_path = app / 'todo-app/package-lock.json'
            original = lock_path.read_text()
            lock = json.loads(original)
            lock['packages']['node_modules/@aws-blocks/core']['resolved'] = 'https://registry.npmjs.org/core.tgz'
            lock_path.write_text(json.dumps(lock))
            with self.assertRaisesRegex(AssertionError, 'wrong registry'):
                verify(registry, app, ledger)
            lock['packages']['node_modules/@aws-blocks/core']['link'] = True
            lock_path.write_text(json.dumps(lock))
            with self.assertRaisesRegex(AssertionError, 'workspace link'):
                verify(registry, app, ledger)
            lock_path.write_text(original)
            core = app / 'todo-app/node_modules/@aws-blocks/core/package.json'
            core.write_text('modified')
            with self.assertRaisesRegex(AssertionError, 'modified package'):
                verify(registry, app, ledger)


class ReportTests(unittest.TestCase):
    def test_differences_keep_failed_usage_and_zero_baseline_unknown_percent(self):
        self.assertEqual(difference(46, 36), (-10, -1000 / 46))
        self.assertEqual(difference(0, 8), (8, None))
        self.assertEqual(difference(None, 8), (None, None))

    def test_later_failure_does_not_hide_successful_phase_pairs(self):
        baseline = {'harbor_exit_code': 0, 'same_session': True, 'phases': [
            {'name': name, 'status': 'passed', 'accounting_complete': True}
            for name in ('create', 'due-dates', 'labels')]}
        candidate = json.loads(json.dumps(baseline))
        candidate['phases'][2]['status'] = 'failed'
        self.assertTrue(eligible_pair([baseline, candidate], 'create'))
        self.assertTrue(eligible_pair([baseline, candidate], 'due-dates'))
        self.assertFalse(eligible_pair([baseline, candidate], 'labels'))
        candidate['phases'][0]['status'] = 'failed'
        self.assertFalse(eligible_pair([baseline, candidate], 'due-dates'))
        candidate['phases'][0]['status'] = 'passed'
        candidate['same_session'] = False
        self.assertFalse(eligible_pair([baseline, candidate], 'create'))
        self.assertFalse(eligible_pair([baseline, None], 'create'))
    def test_missing_results_remain_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            text = render(Path(temp))
            self.assertIn('NO RESULT', text)
            self.assertIn('n=1', text)

    def test_equal_packages_are_aa_and_artifacts_never_echo_tool_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            identity = {'arm': 'baseline', 'commit': 'a' * 40, 'skill_revision': 'b' * 40, 'packages': []}
            trial = root / 'jobs/baseline/trial'
            trial.mkdir(parents=True)
            (root / 'public').mkdir()
            steps = []
            for name in ('create', 'due-dates', 'labels'):
                metrics = summarize(stream([10, 20, 30, 40, 1.0]))
                metrics.update(scaffolder_command_observed=True, instructions_read_observed=True)
                steps.append({'step_name': name, 'agent_result': {'metadata': {'harbor_bench': metrics}}})
                phase = trial / 'steps' / name
                (phase / 'agent').mkdir(parents=True)
                (phase / 'verifier').mkdir()
                (phase / 'agent/claude-code.txt').write_text(stream([10, 20, 30, 40, 1.0]))
                (phase / 'verifier/verification.json').write_text(json.dumps({'status': 'passed', 'checks': {
                    key: True for key in ('package_provenance', 'build', 'all_phases_and_reload', 'server_restart_fresh_browser')
                }}))
            (trial / 'result.json').write_text(json.dumps({'step_results': steps}))
            result = collect(root, identity, 0, None)
            self.assertEqual(result['status'], 'passed')
            for path in (root / 'public').iterdir():
                self.assertNotIn('private-string', path.read_text())
            for arm in ('baseline', 'candidate'):
                directory = root / f'harbor-result-{arm}'
                directory.mkdir()
                (directory / 'result.json').write_text(json.dumps(result))
            self.assertIn('A/A infrastructure demonstration', render(root))
            failed = dict(result, status='failed', harbor_exit_code=1, same_session=False)
            (root / 'harbor-result-candidate/result.json').write_text(json.dumps(failed))
            report = render(root)


if __name__ == '__main__':
    unittest.main()
