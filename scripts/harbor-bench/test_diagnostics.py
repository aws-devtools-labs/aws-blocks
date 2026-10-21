"""Behavior and privacy boundaries for safe diagnostic summaries."""
import json
import unittest

from accounting import skill_use
from diagnostics import public_failure


def stream(*blocks):
    return '\n'.join(json.dumps({'type': 'assistant', 'message': {'content': [
        {'type': 'tool_use', 'id': str(index), 'name': name, 'input': inputs}]}})
        for index, (name, inputs) in enumerate(blocks))


class DiagnosticsTests(unittest.TestCase):
    def test_browser_failure_names_check_without_publishing_runtime_text(self):
        detail = {'status': 'failed', 'failure': {'check': 'normalize_labels', 'kind': 'assertion',
                                                  'actual': 'secret-from-app', 'message': 'token=private'}}
        result = public_failure({'failure': {'stage': 'ui_exercise', 'kind': 'runtime'}}, {'exercise': detail})
        self.assertEqual(result, {'stage': 'ui_exercise', 'check': 'normalize_labels', 'kind': 'assertion'})
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))

    def test_unknown_strings_never_escape(self):
        result = public_failure({'failure': {'stage': 'ui_survival', 'kind': 'TOKEN'}},
                                {'survival': {'failure': {'check': 'SECRET', 'kind': 'SECRET'}}})
        self.assertEqual(result, {'stage': 'ui_survival', 'check': None, 'kind': 'runtime'})
        self.assertEqual(public_failure({'failure': {'stage': 'SECRET'}}, {})['stage'], 'unknown')
        self.assertIsNone(public_failure({'status': 'passed'}, {}))

    def test_non_browser_stage_ignores_stale_browser_results(self):
        passed = {'exercise': {'status': 'passed'}}
        result = public_failure({'failure': {'stage': 'blocks_persistence', 'kind': 'assertion'}}, passed)
        self.assertEqual(result, {'stage': 'blocks_persistence', 'check': None, 'kind': 'assertion'})

    def test_skill_use_prefers_skill_tool_and_ignores_other_skills(self):
        self.assertEqual(skill_use(stream(('Read', {'file_path': '/x/aws-blocks/SKILL.md'}),
                                          ('Skill', {'skill': 'aws-blocks'}))), 'skill_tool')
        self.assertEqual(skill_use(stream(('Bash', {'command': 'cat ~/.claude/skills/aws-blocks/SKILL.md'}))),
                         'file_read')
        self.assertEqual(skill_use(stream(('Skill', {'skill': 'other'}), ('Read', {'file_path': '/app/AGENTS.md'}))),
                         'none')
        self.assertEqual(skill_use(''), 'none')


if __name__ == '__main__':
    unittest.main()
