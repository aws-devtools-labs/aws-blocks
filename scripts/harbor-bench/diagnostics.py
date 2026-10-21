"""Public diagnostics use verifier-owned identifiers, never arbitrary runtime text."""
import json
from pathlib import Path

CHECKS = json.loads((Path(__file__).parent / 'task/tests/checks.json').read_text())
STAGES = {'package_provenance', 'build', 'server_start', 'ui_exercise', 'blocks_persistence',
          'server_restart', 'ui_survival'}
KINDS = {'timeout', 'assertion', 'runtime'}


def public_failure(verification, ui_results):
    """The first failing stage, its browser check ID when known, and an error kind."""
    failure = verification.get('failure')
    if not isinstance(failure, dict):
        return None
    stage = failure.get('stage') if failure.get('stage') in STAGES else 'unknown'
    detail = {}
    if stage.startswith('ui_') and isinstance(ui_results.get(stage[3:]), dict):
        detail = ui_results[stage[3:]].get('failure') or {}
    kind = detail.get('kind', failure.get('kind'))
    return {
        'stage': stage,
        'check': detail.get('check') if detail.get('check') in CHECKS else None,
        'kind': kind if kind in KINDS else 'runtime',
    }
