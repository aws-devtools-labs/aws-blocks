"""Behavior and privacy boundaries for safe diagnostic summaries."""
import json
import unittest

from diagnostics import public_diagnostics
from discovery import summarize_discovery


class DiagnosticsTests(unittest.TestCase):
    def test_failure_identifies_contract_without_publishing_runtime_text(self):
        detail = {'status': 'failed', 'checks': ['app_ready', 'prior_data'],
                  'browser_errors': 1, 'http_errors': 2,
                  'failure': {'check': 'normalize_labels', 'kind': 'assertion', 'reason': 'value_mismatch',
                              'actual': 'secret-from-app', 'message': 'token=private'}}
        result = public_diagnostics({'failure': {'stage': 'ui_exercise', 'kind': 'runtime'}}, {'exercise': detail})
        self.assertEqual(result['failure'], {'stage': 'ui_exercise', 'check': 'normalize_labels', 'kind': 'assertion', 'reason': 'value_mismatch'})
        self.assertEqual(result['checks_passed'], 2)
        self.assertEqual(result['browser_errors'], 1)
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))

    def test_unknown_diagnostic_strings_never_escape_and_missing_is_unknown(self):
        result = public_diagnostics({'failure': {'stage': 'SECRET', 'kind': 'TOKEN'}}, {})
        self.assertEqual(result['failure']['stage'], 'unknown')
        self.assertIsNone(result['checks_passed'])
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertNotIn('TOKEN', json.dumps(result))

    def test_discovery_deduplicates_reads_and_ignores_embedded_source(self):
        def call(id, name, inputs):
            return {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': id, 'name': name, 'input': inputs}]}}
        read = call('a', 'Read', {'file_path': '/app/AGENTS.md'})
        values = [read, read,
                  call('b', 'Bash', {'command': 'cat /home/node/.claude/skills/aws-blocks/SKILL.md && head -40 node_modules/@aws-blocks/blocks/README.md'}),
                  call('c', 'Bash', {'command': "cat <<'EOF'\nnode_modules/@aws-blocks/core/dist/index.js\nEOF"}),
                  call('d', 'Grep', {'path': 'node_modules/@aws-blocks/core/dist/index.js'}),
                  {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'd', 'is_error': True}]}},
                  {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'd', 'is_error': True}]}}]
        result = summarize_discovery('\n'.join(json.dumps(v) for v in values))
        self.assertEqual(result, {'skill': 1, 'app_instructions': 1, 'block_docs': 1,
                                 'framework_source': 1, 'failed_tools': 1, 'observed_tools': 4})
        self.assertIsNone(summarize_discovery(''))
        self.assertNotIn('node_modules', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
