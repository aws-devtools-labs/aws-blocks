"""Credential-free harness regression tests; no paid model calls or Docker required."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from accounting import summarize
from pins import PRICE_CACHE_READ, PRICE_CACHE_WRITE, PRICE_INPUT, PRICE_OUTPUT
from provenance import stored_in_blocks, verify
from public_result import collect
from report import difference, eligible_pair, render

MODEL = 'global.anthropic.claude-opus-5-5'


def stream(values, session='session-a', turns=3, duplicate=False, calls=None):
    """`values` are cumulative (input, cache read, cache write, output, cost); `calls` are per-call
    (input, cache write, cache read) of this invocation, by default one call with all of `values`."""
    events = []
    for index, (uncached, write, read) in enumerate(calls or [(values[0], values[2], values[1])], 1):
        assistant = {'type': 'assistant', 'message': {'id': f'message-{index}', 'content': [], 'usage': {
            'input_tokens': uncached, 'cache_creation_input_tokens': write, 'cache_read_input_tokens': read,
            'output_tokens': 1}}}
        if index == 1:
            assistant['message']['content'].append(
                {'type': 'tool_use', 'id': 'tool-1', 'name': 'Bash', 'input': {'command': 'private-string'}})
        events += [assistant, assistant] if duplicate else [assistant]
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
        for values, turns, calls in [([10, 20, 30, 40, 1.0], 5, [(10, 30, 20)]),
                                     ([15, 40, 35, 50, 1.5], 2, [(5, 5, 20)]),
                                     ([20, 70, 40, 65, 2.0], 3, [(5, 5, 30)])]:
            previous = summarize(stream(values, turns=turns, duplicate=True, calls=calls), previous)
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

    def test_input_processed_and_cache_neutral_cost(self):
        # Phase 1: a 2,002-token prefix, then 1,000 more; phase 2 continues the session with 503 more.
        own = summarize(stream([4, 2000, 3000, 500, 0.0], calls=[(2, 2000, 0), (2, 1000, 2000)]))
        self.assertEqual(own['usage']['input_processed_tokens'], 5004)
        growth = 2002 + 1000
        expected = growth * PRICE_CACHE_WRITE + (5004 - growth) * PRICE_CACHE_READ + 500 * PRICE_OUTPUT
        self.assertAlmostEqual(own['usage']['cache_neutral_cost_usd'], expected, places=12)
        self.assertEqual(own['context_end'], 3002)
        self.assertEqual(own['accounting_errors'], [])
        # The same work with the prefix served from another session's cache: list price falls, the
        # cache-neutral cost does not.
        shared = summarize(stream([4, 4000, 1000, 500, 0.0], calls=[(2, 0, 2000), (2, 1000, 2000)]))
        self.assertEqual(shared['usage']['input_processed_tokens'], 5004)
        self.assertAlmostEqual(shared['usage']['cache_neutral_cost_usd'], expected, places=12)
        second = summarize(stream([7, 5002, 3500, 800, 0.0], calls=[(3, 500, 3002)]), own)
        self.assertEqual(second['usage']['input_processed_tokens'], 3505)
        self.assertAlmostEqual(second['usage']['cache_neutral_cost_usd'],
                               503 * PRICE_CACHE_WRITE + 3002 * PRICE_CACHE_READ + 300 * PRICE_OUTPUT, places=12)

    def test_missing_call_usage_leaves_cache_neutral_cost_unavailable(self):
        first = summarize(stream([4, 2000, 3000, 500, 0.0], calls=[(2, 2000, 0), (2, 1000, 2000)]))
        no_usage = stream([4, 2000, 3000, 500, 0.0]).replace('"usage"', '"other"')
        for metrics in (summarize(no_usage),
                        # Per-call usage that does not add up to the counted input misses calls.
                        summarize(stream([4, 2000, 3000, 500, 0.0], calls=[(2, 2000, 0)])),
                        # Without the previous phase's context, growth is unknown.
                        summarize(stream([7, 5002, 3500, 800, 0.0], calls=[(3, 500, 3002)]),
                                  summarize('', first))):
            self.assertIsNone(metrics['usage']['cache_neutral_cost_usd'])
            self.assertIsNone(metrics['context_end'])
            self.assertIn('unavailable_cache_neutral_cost_usd', metrics['accounting_errors'])
        self.assertEqual(summarize(no_usage)['usage']['input_processed_tokens'], 5004)
        missing = summarize('', first)['usage']
        self.assertIsNone(missing['input_processed_tokens'])
        self.assertIsNone(missing['cache_neutral_cost_usd'])

    def test_price_pins_reproduce_claude_code_list_price(self):
        # Usage and total_cost_usd of one recorded create phase of the pinned model and CLI.
        listed = 22 * PRICE_INPUT + 36446 * PRICE_CACHE_WRITE + 270268 * PRICE_CACHE_READ + 4850 * PRICE_OUTPUT
        self.assertAlmostEqual(listed, 0.3333716, places=10)


class ProvenanceTests(unittest.TestCase):
    def test_real_tarball_bytes_lock_origin_and_served_scaffolder_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            registry, app = root / 'registry', root / 'todo-app'
            registry.mkdir()
            manifest, served, entries = [], [], {}
            for short in ('create-blocks-app', 'blocks', 'core'):
                name = '@aws-blocks/' + short
                key = f'registry/{name}/-/{short}-1.0.0.tgz'
                tarball = registry / key
                tarball.parent.mkdir(parents=True)
                content = json.dumps({'name': name, 'version': '1.0.0'}).encode()
                with tarfile.open(tarball, 'w:gz') as archive:
                    member = tarfile.TarInfo('package/package.json')
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
                manifest.append({'name': name, 'version': '1.0.0', 'integrity': 'sha512-test', 'tarballS3Key': key})
                served.append(json.dumps({'path': '/' + key}))
                if short == 'create-blocks-app':
                    continue  # Run through npm create; not an app dependency.
                location = f'node_modules/{name}'
                (app / location).mkdir(parents=True)
                (app / location / 'package.json').write_bytes(content)
                entries[location] = {'version': '1.0.0', 'integrity': 'sha512-test', 'resolved': 'http://localhost:4873/' + key}
            entries['node_modules/@aws-blocks/core/node_modules/zod'] = {'version': '3.0.0'}
            (app / 'package-lock.json').write_text(json.dumps({'packages': entries}))
            (registry / 'publish-manifest.json').write_text(json.dumps({'packages': manifest}))
            (app / 'aws-blocks').mkdir()
            (app / 'aws-blocks/index.ts').write_text('import { ApiNamespace, KVStore } from "@aws-blocks/blocks";')
            ledger = root / 'ledger.jsonl'
            ledger.write_text('\n'.join(served))
            self.assertEqual([p['name'] for p in verify(registry, app, ledger)['packages']],
                             ['@aws-blocks/blocks', '@aws-blocks/core'])
            ledger.write_text('\n'.join(served[1:]))
            with self.assertRaisesRegex(AssertionError, 'scaffolder was not served'):
                verify(registry, app, ledger)
            ledger.write_text('\n'.join(served))
            lock_path = app / 'package-lock.json'
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
            (app / 'node_modules/@aws-blocks/core/package.json').write_text('modified')
            with self.assertRaisesRegex(AssertionError, 'modified package'):
                verify(registry, app, ledger)

    def test_records_must_be_in_blocks_mock_data_not_elsewhere(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp)
            (app / '.bb-data/app-todos').mkdir(parents=True)
            (app / '.bb-data/app-todos/store.json').write_text('{"1":{"title":"survival-a"}}')
            (app / 'data.json').write_text('["survival-b"]')  # Stored outside the Blocks mock directory.
            (app / 'node_modules/x/.bb-data').mkdir(parents=True)
            (app / 'node_modules/x/.bb-data/f').write_text('survival-b')
            self.assertEqual(stored_in_blocks(app, ['survival-a']), [])
            self.assertEqual(stored_in_blocks(app, ['survival-a', 'survival-b']), ['survival-b'])


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
                metrics['skill_use'] = 'skill_tool'
                steps.append({'step_name': name, 'agent_result': {'metadata': {'harbor_bench': metrics}}})
                phase = trial / 'steps' / name
                (phase / 'agent').mkdir(parents=True)
                (phase / 'verifier').mkdir()
                (phase / 'agent/claude-code.txt').write_text(stream([10, 20, 30, 40, 1.0]))
                (phase / 'verifier/verification.json').write_text(json.dumps({'status': 'passed', 'checks': {
                    key: True for key in ('package_provenance', 'build', 'all_phases_and_reload',
                                          'blocks_persistence', 'server_restart_fresh_browser')
                }}))
            (trial / 'result.json').write_text(json.dumps({'step_results': steps}))
            result = collect(root, identity, 0, None)
            self.assertEqual(result['status'], 'passed')
            self.assertEqual({p['skill_use'] for p in result['phases']}, {'skill_tool'})
            for path in (root / 'public').iterdir():
                self.assertNotIn('private-string', path.read_text())
            for arm in ('baseline', 'candidate'):
                directory = root / f'harbor-result-{arm}-1'
                directory.mkdir()
                (directory / 'result.json').write_text(json.dumps(result))
            self.assertIn('A/A infrastructure demonstration', render(root))
            failed = dict(result, status='failed', harbor_exit_code=1, same_session=False)
            (root / 'harbor-result-candidate-1/result.json').write_text(json.dumps(failed))
            self.assertIn('| **total** | passed | failed | no |', render(root))
            # Without the .bb-data check the phase is not a pass, whatever else succeeded.
            verification = trial / 'steps/labels/verifier/verification.json'
            data = json.loads(verification.read_text())
            del data['checks']['blocks_persistence']
            verification.write_text(json.dumps(data))
            self.assertEqual(collect(root, identity, 0, None)['phases'][2]['status'], 'failed')
            verification.write_text(json.dumps(dict(data, checks={**data['checks'], 'blocks_persistence': True})))

            # Harbor stops after a failed gated phase: the earlier passing pair stays comparable.
            stopped = root / 'jobs/candidate/trial'
            stopped.mkdir(parents=True)
            (stopped / 'result.json').write_text(json.dumps({'step_results': steps[:2]}))
            for name, status in (('create', 'passed'), ('due-dates', 'failed')):
                (stopped / 'steps' / name / 'verifier').mkdir(parents=True)
                checks = {key: status == 'passed' for key in ('package_provenance', 'build', 'all_phases_and_reload',
                                                             'blocks_persistence', 'server_restart_fresh_browser')}
                (stopped / 'steps' / name / 'verifier/verification.json').write_text(
                    json.dumps({'status': status, 'checks': checks}))
            candidate = collect(root, dict(identity, arm='candidate'), 0, None)
            self.assertTrue(candidate['same_session'])
            self.assertEqual(candidate['status'], 'failed')
            self.assertEqual([p['status'] for p in candidate['phases']], ['passed', 'failed', 'not_run'])
            (root / 'harbor-result-candidate-1/result.json').write_text(json.dumps(candidate))
            report = render(root)
            self.assertIn('| create | passed, skill: skill_tool | passed, skill: skill_tool | yes (n=1) |', report)
            self.assertIn('| due-dates | passed, skill: skill_tool | failed, skill: skill_tool | no |', report)


if __name__ == '__main__':
    unittest.main()
