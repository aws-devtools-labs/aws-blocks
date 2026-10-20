"""Render advisory evidence without executing artifact contents or echoing arbitrary strings."""
import json
import os
from pathlib import Path
import re
import sys

from diagnostics import CHECKS, KINDS, STAGES

ARMS = ('baseline', 'candidate')
PHASES = ('create', 'due-dates', 'labels')
STATUSES = ('passed', 'failed', 'not_run')
SKILL_USE = ('skill_tool', 'file_read', 'none')
COLUMNS = (('New input', 'new_input'), ('Cache read', 'cache_read_tokens'), ('Output', 'output_tokens'),
           ('Turns', 'turns'), ('Tools', 'tool_calls'), ('Seconds', 'seconds'), ('Cost', 'cost_usd'))


def number(value):
    return value if type(value) in (int, float) else None


def measurements(phase):
    usage = phase.get('usage') or {}
    uncached, writes = number(usage.get('input_tokens')), number(usage.get('cache_write_tokens'))
    duration = number(phase.get('duration_ms'))
    return {
        'new_input': uncached + writes if uncached is not None and writes is not None else None,
        'cache_read_tokens': number(usage.get('cache_read_tokens')),
        'output_tokens': number(usage.get('output_tokens')),
        'turns': number(phase.get('turns')), 'tool_calls': number(phase.get('tool_calls')),
        'seconds': duration / 1000 if duration is not None else None,
        'cost_usd': number(usage.get('cost_usd')),
    }


def totals(phases):
    values = [measurements(phases.get(name, {})) for name in PHASES]
    return {key: sum(v[key] for v in values) if all(v[key] is not None for v in values) else None
            for _, key in COLUMNS}


def difference(a, b):
    if type(a) not in (int, float) or type(b) not in (int, float):
        return None, None
    return b - a, (100 * (b - a) / a if a else None)


def delta_text(a, b, cost=False):
    delta, percent = difference(a, b)
    if delta is None:
        return '—'
    absolute = f'${delta:+.4f}' if cost else f'{delta:+,.0f}'
    return absolute + (f' ({percent:+.1f}%)' if percent is not None else ' (baseline zero)')


def eligible_pair(results, name):
    for result in results:
        if not result or result.get('harbor_exit_code') != 0 or result.get('same_session') is not True:
            return False
        phases = {phase['name']: phase for phase in result.get('phases', [])}
        for required in PHASES[:PHASES.index(name) + 1]:
            phase = phases.get(required, {})
            if phase.get('status') != 'passed' or phase.get('accounting_complete') is not True:
                return False
    return True


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def sha(value):
    return value if re.fullmatch('[0-9a-f]{40}', value or '') else 'unavailable'


def outcome(phase):
    status = phase.get('status') if phase.get('status') in STATUSES else 'missing'
    skill = phase.get('skill_use')
    return f'{status}, skill: {skill}' if skill in SKILL_USE else status


def row(label, comparable, values, outcomes):
    cells = [label, *outcomes, 'yes (n=1)' if comparable else 'no']
    cells += [delta_text(values[0][key], values[1][key], key == 'cost_usd') for _, key in COLUMNS]
    return '| ' + ' | '.join(cells) + ' |'


def render(root):
    arms = {arm: load(root / f'harbor-result-{arm}' / 'result.json') for arm in ARMS}
    url = os.environ.get('RUN_URL', '')
    if not re.fullmatch(r'https://github\.com/[\w.-]+/[\w.-]+/actions/runs/\d+', url):
        url = ''
    lines = ['## Harbor agent check — advisory', '',
             'One todo-app trajectory per arm; **n=1, not a statistical performance claim**. '
             'Local mock mode only; nothing is deployed.', '',
             f'- Baseline: `{sha(os.environ.get("BASELINE_SHA"))}` (merge-base with the PR base).',
             f'- Candidate: `{sha(os.environ.get("CANDIDATE_SHA"))}` (PR head).',
             f'- Harness: `{sha(os.environ.get("HARNESS_SHA"))}` (trusted workflow revision, both arms).',
             f'- [Workflow and evidence]({url})' if url else '- Local report (no workflow URL).']
    for arm, result in arms.items():
        if not result:
            lines.append(f'- **{arm}: NO RESULT** (setup, cancellation or infrastructure failure).')
            continue
        status = result.get('status') if result.get('status') in ('passed', 'failed', 'infrastructure_error') else 'unknown'
        continuity = 'verified' if result.get('same_session') is True else 'not verified'
        lines.append(f'- **{arm}: {status}**; session continuity {continuity}.')
    lines.append('')
    if all(arms.values()):
        digests = [sorted((p['name'], p['integrity']) for p in arms[arm]['packages']) for arm in ARMS]
        lines += ['**A/A infrastructure demonstration:** both arms packed identical packages, so differences are '
                  'agent and runtime variation, not a framework change.' if digests[0] == digests[1] else
                  'Packed packages differ between arms.', '']
    failures = []
    for arm, result in arms.items():
        for phase in (result or {}).get('phases', []):
            if phase.get('status') != 'failed' or phase.get('name') not in PHASES:
                continue
            failure = phase.get('failure') or {}
            stage = failure.get('stage') if failure.get('stage') in STAGES else 'agent or accounting'
            kind = f', {failure["kind"]}' if failure.get('kind') in KINDS else ''
            check = CHECKS.get(failure.get('check'), '')
            failures.append(f'- **{arm} / {phase["name"]}**: {stage}{kind}. {check}'.rstrip())
    if failures:
        lines += ['### Failures', '', *failures, '']
    lines += ['### Candidate − baseline', '',
              '| Phase | Baseline | Candidate | Comparable | ' + ' | '.join(f'{label} Δ' for label, _ in COLUMNS) + ' |',
              '|---|---|---|---|' + '---:|' * len(COLUMNS)]
    phases = {arm: {p['name']: p for p in (arms[arm] or {}).get('phases', [])} for arm in ARMS}
    for name in PHASES:
        pair = [phases[arm].get(name, {}) for arm in ARMS]
        lines.append(row(name, eligible_pair(list(arms.values()), name),
                         [measurements(p) for p in pair], [outcome(p) for p in pair]))
    whole = all(result and result.get('status') == 'passed' for result in arms.values())
    lines.append(row('**total**', whole, [totals(phases[arm]) for arm in ARMS],
                     [(arms[arm] or {}).get('status', 'missing') for arm in ARMS]))
    lines += ['', 'Δ is candidate − baseline (percent of baseline). New input = uncached input + cache writes. '
              'Cost is Claude Code’s list-price estimate, not AWS billing. Rows marked not comparable include '
              'failed or incomplete work: less usage there is not an efficiency win. '
              '`skill` shows how the agent reached the installed aws-blocks skill.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(render(Path(sys.argv[1])))
