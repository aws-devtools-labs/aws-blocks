"""Render advisory evidence without executing artifact contents or echoing arbitrary strings."""
import json
import os
from pathlib import Path
import re
import sys

from diagnostics import CHECKS, STAGES, KINDS, REASONS
from discovery import CATEGORIES

ARMS = ('baseline', 'candidate')
PHASES = ('create', 'due-dates', 'labels')
FIELDS = ('input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd')
METRICS = (*FIELDS, 'turns', 'tool_calls', 'duration_ms')


def measurements(phase):
    return {**{key: (phase.get('usage') or {}).get(key) for key in FIELDS},
            **{key: phase.get(key) for key in METRICS if key not in FIELDS}}


def difference(a, b):
    if type(a) not in (int, float) or type(b) not in (int, float):
        return None, None
    return b - a, (100 * (b - a) / a if a else None)


def delta_text(a, b, cost=False):
    delta, percent = difference(a, b)
    if delta is None:
        return '—'
    absolute = f'{delta:+.4f}' if cost else f'{delta:+,.0f}'
    if cost:
        absolute = '$' + absolute
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


def number(value, cost=False):
    if type(value) not in (int, float):
        return '—'
    return f'${value:.4f}' if cost else f'{value:,.0f}'


def sha(value):
    return value if re.fullmatch('[0-9a-f]{40}', value or '') else 'unavailable'


def render(root):
    arms = {arm: load(root / f'harbor-result-{arm}' / 'result.json') for arm in ARMS}
    url = os.environ.get('RUN_URL', '')
    if not re.fullmatch(r'https://github.com/(?:xyos|aws-devtools-labs)/aws-blocks/actions/runs/\d+', url):
        url = ''
    lines = ['## Harbor agent check — advisory', '',
             'One todo-app trajectory per arm; **n=1, not a statistical performance claim**.', '',
             f'- Baseline: `{sha(os.environ.get("BASELINE_SHA"))}` (merge-base with the requested PR base).',
             f'- Candidate: `{sha(os.environ.get("CANDIDATE_SHA"))}` (PR head, not GitHub’s synthetic merge).',
             f'- Harness: `{sha(os.environ.get("HARNESS_SHA"))}` (trusted workflow revision, identical for both arms).',
             '- Same pinned Harbor/Claude/skill/task, separate clean containers and registries; each arm resumes one session.',
             '- Local mock behavior only; no AWS application deployment or production correctness claim.',
             f'- [Workflow and downloadable evidence]({url})' if url else '- Local report (no workflow URL).', '']
    for arm, result in arms.items():
        if result:
            status = result.get('status')
            status = status if status in ('passed', 'failed', 'infrastructure_error') else 'unknown'
            exit_code = result.get('harbor_exit_code')
            exit_code = str(exit_code) if type(exit_code) is int else 'unavailable'
            continuity = 'verified' if result.get('same_session') is True else 'not verified'
            lines.append(f'- **{arm}: {status}**; Harbor exit: {exit_code}; session continuity: {continuity}.')
    lines.append('')
    def digests(result):
        return sorted((p['name'], p['integrity']) for p in result['packages'])
    if all(arms.values()):
        if digests(arms['baseline']) == digests(arms['candidate']):
            lines += ['**A/A infrastructure demonstration:** baseline and candidate packed package digests are identical. '
                      'Observed differences may include agent and runtime variation; they do not establish a framework improvement.', '']
        else:
            lines += ['Packed package digests differ; this is a single descriptive baseline/candidate comparison.', '']
    lines += ['### What needs attention', '']
    failures = []
    for arm, result in arms.items():
        for phase in (result or {}).get('phases', []):
            if phase.get('status') != 'failed' or phase.get('name') not in PHASES:
                continue
            diagnostic = phase.get('diagnostics') or {}
            failure = diagnostic.get('failure') or {}
            stage = failure.get('stage') if failure.get('stage') in STAGES else 'verification'
            kind = failure.get('kind') if failure.get('kind') in KINDS else 'unavailable'
            check = failure.get('check')
            explanation = CHECKS.get(check, 'No assertion diagnostic captured; inspect accounting and stage results.')
            explanation += ' ' + REASONS.get(failure.get('reason'), '')
            failures.append(f'- **{arm} / {phase["name"]}: {stage}, {kind}.** {explanation}')
    lines += failures or ['No recorded failed phases. Missing or stopped phases are not passes.']
    lines += ['', '<details>', '<summary>Raw per-phase measurements</summary>', '']
    lines += ['| Arm / phase | Outcome | Input (uncached) | Cache read | Cache write | Output | Turns | Tools | Agent seconds | CLI list-price estimate |',
              '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    totals = {}
    for arm in ARMS:
        result = arms[arm]
        if not result:
            lines.append(f'| {arm} | NO RESULT (setup, cancellation, or infrastructure failure) | — | — | — | — | — | — | — | — |')
            continue
        phases = {phase['name']: phase for phase in result.get('phases', [])}
        for name in PHASES:
            phase = phases.get(name, {})
            status = phase.get('status')
            status = status if status in ('passed', 'failed', 'not_run') else 'missing'
            usage = phase.get('usage') or {}
            duration = phase.get('duration_ms')
            cells = [f'{arm} / {name}', status]
            cells += [number(usage.get(field)) for field in FIELDS[:-1]]
            cells += [number(phase.get('turns')), number(phase.get('tool_calls')),
                      number(duration / 1000 if type(duration) in (int, float) else None), number(usage.get('cost_usd'), True)]
            lines.append('| ' + ' | '.join(cells) + ' |')
        totals[arm] = {}
        for field in METRICS:
            values = [measurements(phases.get(name, {})).get(field) for name in PHASES]
            totals[arm][field] = sum(values) if all(type(v) in (int, float) for v in values) else None
    lines += ['', '</details>', '']
    lines += ['', '### Measured candidate − baseline by phase', '',
              'Arithmetic differences remain visible when a phase fails. Only pairs with passing prerequisites, '
              'complete accounting and verified session continuity are eligible for an efficiency comparison.', '',
              '| Phase | Comparison | New input Δ | Cache read Δ | Turns Δ | Tools Δ | Seconds Δ | Cost Δ |',
              '|---|---|---:|---:|---:|---:|---:|---:|']
    for name in PHASES:
        pair = [next((p for p in (arms[arm] or {}).get('phases', []) if p['name'] == name), {}) for arm in ARMS]
        values = [measurements(p) for p in pair]
        eligibility = 'eligible (n=1)' if eligible_pair(list(arms.values()), name) else 'not comparable for efficiency'
        cells = [name, eligibility]
        for field in ('new_input', 'cache_read_tokens', 'turns', 'tool_calls', 'duration_ms', 'cost_usd'):
            a, b = (v.get(field) for v in values)
            if field == 'new_input':
                a, b = (v['input_tokens'] + v['cache_write_tokens']
                        if all(type(v.get(k)) in (int, float) for k in ('input_tokens', 'cache_write_tokens'))
                        else None for v in values)
            if field == 'duration_ms':
                a, b = (v / 1000 if type(v) in (int, float) else None for v in (a, b))
            cells.append(delta_text(a, b, field == 'cost_usd'))
        lines.append('| ' + ' | '.join(cells) + ' |')
    lines += ['', 'New input = uncached input + cache writes. Raw output and cache-write counts are in the expandable measurements.', '',
              '### How the agent looked for guidance', '',
              '| Arm / phase | Skill requests | AGENTS requests | Block docs requests | Framework source requests | Failed tools |',
              '|---|---:|---:|---:|---:|---:|']
    for arm, result in arms.items():
        for phase in (result or {}).get('phases', []):
            if phase.get('name') not in PHASES:
                continue
            discovery = phase.get('discovery') or {}
            cells = [f'{arm} / {phase["name"]}'] + [number(discovery.get(k)) for k in (*CATEGORIES, 'failed_tools')]
            lines.append('| ' + ' | '.join(cells) + ' |')
    lines += ['', 'These are deduplicated inspection requests, not proof that the file was read successfully. '
              'Shell parsing covers direct read/search commands only; embedded scripts and automatic context injection are not counted. '
              'One tool call can inspect more than one category. Missing capture is unavailable, not zero.', '',
              '<details>', '<summary>Whole-run totals and interpretation</summary>', '']
    comparable = all(result and result.get('status') == 'passed' for result in arms.values())
    lines += ['', '### Measured candidate − baseline totals', '',
              'All phases passed in both arms; descriptive comparison only.' if comparable else
              '**Not comparable for efficiency:** totals include failed or incomplete work. Lower usage is not an efficiency win.', '',
              '| Metric | Baseline | Candidate | Difference |', '|---|---:|---:|---:|']
    for field in METRICS:
        a, b = (totals.get(arm, {}).get(field) for arm in ARMS)
        cost = field == 'cost_usd'
        label = field
        if field == 'duration_ms':
            label = 'agent_seconds'
            a, b = (v / 1000 if type(v) in (int, float) else None for v in (a, b))
        lines.append(f'| {label} | {number(a, cost)} | {number(b, cost)} | {delta_text(a, b, cost)} |')
    lines += ['', '### Interpretation and evidence', '',
              '- Success requires every phase’s build, packed-byte provenance, browser CRUD/regression suite, '
              'fresh-browser/server-restart persistence, and complete same-session accounting. Missing/failed phases are not passes.',
              '- Token/cache/cost totals are differences of cumulative `modelUsage`/`total_cost_usd` snapshots. '
              'Turns and tool calls are invocation-local, not differenced again. Missing or decreasing counters stay unavailable.',
              '- Cost is Claude Code’s list-price estimate, not an AWS billing measurement. There is no dollar cap. '
              'Each phase is bounded to 200 turns / 25 minutes; the whole Harbor process is bounded to 100 minutes.',
              '- Result artifacts contain phase metrics, consumed package hashes, and tool-name-only traces. '
              'Raw model text, shell commands, native sessions, generated app files, credentials, and AWS identities are not uploaded.',
              '- This workflow is non-required/advisory. A red job is preserved honestly; do not configure it as a branch-protection gate.', '', '</details>', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(render(Path(sys.argv[1])))
