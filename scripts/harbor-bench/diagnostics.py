"""Public diagnostics use verifier-owned identifiers, never arbitrary runtime text."""
import json
from pathlib import Path

CHECKS = json.loads((Path(__file__).parent / 'task/tests/checks.json').read_text())
STAGES = {'package_provenance', 'build', 'server_start', 'ui_exercise', 'server_restart', 'ui_survival'}
KINDS = {'timeout', 'assertion', 'runtime'}
REASONS = {
    'control_timeout': 'Control or response did not become ready before the deadline.',
    'value_mismatch': 'Observed value did not match the required value.',
    'checkbox_state_unchanged': 'The checkbox click did not leave the requested state.',
    'element_detached': 'The control was replaced during the browser action.',
    'ambiguous_control': 'More than one element matched the required control.',
    'browser_closed': 'The browser or page closed before verification finished.',
    'navigation_error': 'The browser could not load the local app.',
    'runtime_error': 'Browser action failed; no more specific safe reason was captured.',
}


def count(value):
    return value if type(value) is int and 0 <= value <= 1000000 else None


def public_diagnostics(verification, ui_results):
    result = {'failure': None, 'checks_passed': 0, 'browser_errors': 0, 'http_errors': 0}
    failure = verification.get('failure') or {}
    if failure:
        result['failure'] = {
            'stage': failure.get('stage') if failure.get('stage') in STAGES else 'unknown',
            'check': None,
            'kind': failure.get('kind') if failure.get('kind') in KINDS else 'runtime',
            'reason': failure.get('reason') if failure.get('reason') in REASONS else None,
        }
    for mode, data in ui_results.items():
        if mode not in ('exercise', 'survival') or not isinstance(data, dict):
            continue
        result['checks_passed'] += len({x for x in data.get('checks', []) if isinstance(x, str) and x in CHECKS})
        for key in ('browser_errors', 'http_errors'):
            value = count(data.get(key))
            if value is not None:
                result[key] += value
        if data.get('status') == 'failed':
            detail = data.get('failure') or {}
            result['failure'] = {
                'stage': 'ui_' + mode,
                'check': detail.get('check') if detail.get('check') in CHECKS else 'unknown',
                'kind': detail.get('kind') if detail.get('kind') in KINDS else 'runtime',
                'reason': detail.get('reason') if detail.get('reason') in REASONS else None,
            }
    if not ui_results:
        for key in ('checks_passed', 'browser_errors', 'http_errors'):
            result[key] = None
    return result
