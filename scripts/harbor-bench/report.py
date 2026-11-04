"""Render advisory evidence without executing artifact contents or echoing arbitrary strings."""
import argparse
import json
import os
from pathlib import Path
import re

from diagnostics import CHECKS, KINDS, REASONS, STAGES
from public_result import STORAGE
from stats import MIN_COMPARABLE, bootstrap_median_difference, cv, median_iqr, wilson
from trials import MAX_TRIALS, parse_trials

ARMS = ('baseline', 'candidate')
PHASES = ('create', 'due-dates', 'labels')
TOTAL = 'total'
STATUSES = ('passed', 'failed', 'not_run')
RUN_STATUSES = ('passed', 'failed', 'infrastructure_error')
SKILL_USE = ('skill_tool', 'file_read', 'none')
PRIMARY = 'cache_neutral_cost_usd'
# Compared across arms; the first column is the primary metric.
COLUMNS = (('Cache-neutral cost (primary)', PRIMARY), ('Input processed', 'input_processed_tokens'),
           ('Output', 'output_tokens'), ('Turns', 'turns'), ('Tools', 'tool_calls'), ('Seconds', 'seconds'),
           ('List-price cost', 'cost_usd'))
# Descriptive only: they depend on which session warmed the prompt cache, so arms are not compared on them.
DESCRIPTIVE = (('New input†', 'new_input'), ('Cache read†', 'cache_read_tokens'))
METRICS = COLUMNS + DESCRIPTIVE
COSTS = ('cost_usd', PRIMARY)
RESULT_DIR = re.compile(r'harbor-result-(baseline|candidate)-([1-9][0-9]*)')


def number(value):
    return value if type(value) in (int, float) else None


def measurements(phase):
    usage = phase.get('usage') or {}
    uncached, writes = number(usage.get('input_tokens')), number(usage.get('cache_write_tokens'))
    duration = number(phase.get('duration_ms'))
    return {
        'new_input': uncached + writes if uncached is not None and writes is not None else None,
        'cache_read_tokens': number(usage.get('cache_read_tokens')),
        'input_processed_tokens': number(usage.get('input_processed_tokens')),
        'output_tokens': number(usage.get('output_tokens')),
        'turns': number(phase.get('turns')), 'tool_calls': number(phase.get('tool_calls')),
        'seconds': duration / 1000 if duration is not None else None,
        'cost_usd': number(usage.get('cost_usd')),
        PRIMARY: number(usage.get(PRIMARY)),
    }


def totals(phases):
    values = [measurements(phases.get(name, {})) for name in PHASES]
    return {key: sum(v[key] for v in values) if all(v[key] is not None for v in values) else None
            for _, key in METRICS}


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


def phase_map(result):
    return {phase['name']: phase for phase in (result or {}).get('phases', [])
            if isinstance(phase, dict) and phase.get('name') in PHASES}


def eligible(result, name):
    """This phase and every earlier one passed with complete accounting, in one clean session."""
    if not result or result.get('harbor_exit_code') != 0 or result.get('same_session') is not True:
        return False
    if name == TOTAL:
        return result.get('status') == 'passed'
    phases = phase_map(result)
    return all(phases.get(required, {}).get('status') == 'passed'
               and phases.get(required, {}).get('accounting_complete') is True
               for required in PHASES[:PHASES.index(name) + 1])


def eligible_pair(results, name):
    return all(eligible(result, name) for result in results)


def sample(result, name):
    return totals(phase_map(result)) if name == TOTAL else measurements(phase_map(result).get(name, {}))


def load(path):
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def load_trials(root, trials=None):
    """{arm: {trial: result or None}} for trials 1..N (N given, else the largest trial found)."""
    found = {}
    for path in sorted(root.iterdir()) if root.is_dir() else []:
        match = RESULT_DIR.fullmatch(path.name)
        if match and int(match[2]) <= MAX_TRIALS:
            found[match[1], int(match[2])] = load(path / 'result.json')
    count = trials or max([trial for _, trial in found] or [1])
    return {arm: {trial: found.get((arm, trial)) for trial in range(1, count + 1)} for arm in ARMS}


def counted(result):
    """Infrastructure failures are excluded from pass rates and listed instead."""
    return result is not None and result.get('status') != 'infrastructure_error'


def storage_of(result):
    return result.get('storage') if result.get('storage') in STORAGE else 'unknown'


def compare(baseline, candidate):
    """Candidate − baseline median difference, or not comparable below MIN_COMPARABLE values per arm."""
    interval = bootstrap_median_difference(baseline, candidate)
    if interval is None:
        return {'comparable': False, 'n': [len(baseline), len(candidate)]}
    base = median_iqr(baseline)[0]
    return {'comparable': True, 'n': [len(baseline), len(candidate)], **interval,
            'percent': 100 * interval['difference'] / base if base else None}


def aggregate(arms):
    """Per arm and phase pass rates and passed-phase metric summaries; candidate − baseline.

    `storage` stratifies whole runs by the storage block the create phase chose, since that choice
    moves cost far more than run-to-run noise: candidate − baseline is compared within a storage only.
    """
    summary = {'trials': max(len(results) for results in arms.values()), 'arms': {}, 'differences': {},
               'storage': {}}
    samples, strata = {}, {}
    for arm, results in arms.items():
        runs = [result for result in results.values() if counted(result)]
        entry = summary['arms'][arm] = {
            'requested': len(results), 'counted': len(runs),
            'missing': [t for t, result in results.items() if result is None],
            'infrastructure_error': [t for t, result in results.items()
                                     if result is not None and not counted(result)],
            'phases': {},
        }
        for name in (*PHASES, TOTAL):
            passed = [result for result in runs if eligible(result, name)]
            interval = wilson(len(passed), len(runs))
            metrics = {}
            for _, key in METRICS:
                values = [v for v in (sample(result, name)[key] for result in passed) if v is not None]
                samples[arm, name, key] = values
                spread = median_iqr(values)
                metrics[key] = {'n': len(values), 'cv': cv(values), **(
                    dict(zip(('median', 'q1', 'q3'), spread)) if spread else {})}
            entry['phases'][name] = {
                'passes': len(passed), 'n': len(runs),
                'rate': len(passed) / len(runs) if runs else None,
                'wilson': list(interval) if interval else None, 'metrics': metrics,
            }
            if name != TOTAL:
                uses = [phase_map(result).get(name, {}).get('skill_use') for result in runs]
                entry['phases'][name]['skill_use'] = {use: uses.count(use) for use in SKILL_USE if use in uses}
        for result in runs:
            trials, values = strata.setdefault((storage_of(result), arm), ([], []))
            trials.append(result)
            if eligible(result, TOTAL) and (value := sample(result, TOTAL)[PRIMARY]) is not None:
                values.append(value)
    for name in STORAGE:
        if not any((name, arm) in strata for arm in ARMS):
            continue
        stratum = summary['storage'][name] = {}
        for arm in ARMS:
            trials, values = strata.get((name, arm), ([], []))
            stratum[arm] = {'trials': len(trials), 'passes': len(values),
                            'median': median_iqr(values)[0] if values else None}
        stratum['difference'] = compare(*(strata.get((name, arm), ([], []))[1] for arm in ARMS))
    for name in (*PHASES, TOTAL):
        summary['differences'][name] = {
            key: compare(samples.get(('baseline', name, key), []), samples.get(('candidate', name, key), []))
            for _, key in COLUMNS}
    return summary


def sha(value):
    return value if re.fullmatch('[0-9a-f]{40}', value or '') else 'unavailable'


def outcome(phase):
    status = phase.get('status') if phase.get('status') in STATUSES else 'missing'
    skill = phase.get('skill_use')
    return f'{status}, skill: {skill}' if skill in SKILL_USE else status


def run_status(result):
    if not result:
        return 'NO RESULT'
    return result.get('status') if result.get('status') in RUN_STATUSES else 'unknown'


def row(label, comparable, values, outcomes):
    cells = [label, *outcomes, 'yes (n=1)' if comparable else 'no']
    cells += [delta_text(values[0][key], values[1][key], key in COSTS) for _, key in COLUMNS]
    return '| ' + ' | '.join(cells) + ' |'


def value_text(value, key, signed=False):
    sign = '+' if signed else ''
    if key in COSTS:
        return f'{"-" if value < 0 else sign}${abs(value):.4f}'
    return f'{value:{sign},.0f}' if float(value).is_integer() or abs(value) >= 100 else f'{value:{sign},.1f}'


def failures(arms, numbered):
    lines = []
    for arm, results in arms.items():
        for trial, result in results.items():
            for phase in (result or {}).get('phases', []):
                if not isinstance(phase, dict) or phase.get('status') != 'failed' or phase.get('name') not in PHASES:
                    continue
                failure = phase.get('failure') or {}
                stage = failure.get('stage') if failure.get('stage') in STAGES else 'agent or accounting'
                kind = f', {failure["kind"]}' if failure.get('kind') in KINDS else ''
                reason = f' ({failure["reason"]})' if failure.get('reason') in REASONS else ''
                check = CHECKS.get(failure.get('check'), '')
                label = f'{arm} trial {trial}' if numbered else arm
                lines.append(f'- **{label} / {phase["name"]}**: {stage}{kind}{reason}. {check}'.rstrip())
    return ['### Failures', '', *lines, ''] if lines else []


def header(intro):
    url = os.environ.get('RUN_URL', '')
    if not re.fullmatch(r'https://github\.com/[\w.-]+/[\w.-]+/actions/runs/\d+', url):
        url = ''
    return ['## Harbor agent check — advisory', '', intro, '',
            f'- Baseline: `{sha(os.environ.get("BASELINE_SHA"))}` (merge-base with the PR base).',
            f'- Candidate: `{sha(os.environ.get("CANDIDATE_SHA"))}` (PR head).',
            f'- Harness: `{sha(os.environ.get("HARNESS_SHA"))}` (trusted workflow revision, both arms).',
            f'- [Workflow and evidence]({url})' if url else '- Local report (no workflow URL).']


def packages_note(results):
    digests = {json.dumps(sorted((p.get('name'), p.get('integrity')) for p in result.get('packages', [])
                                 if isinstance(p, dict)))
               for result in results}
    if len(digests) == 1:
        return ['**A/A infrastructure demonstration:** both arms packed identical packages, so differences are '
                'agent and runtime variation, not a framework change.', '']
    return ['Packed packages differ between arms.', '']


FOOTNOTE = ('**Cache-neutral cost is the primary metric**: each phase at the pinned model’s list prices as if '
            'its own session wrote every context token to the prompt cache once (context growth at the '
            'cache-write rate, the rest of the input processed at the cache-read rate, output at the output '
            'rate), so it does not depend on which concurrent session warmed the cache. Input processed = '
            'uncached input + cache writes + cache reads. List-price cost is Claude Code’s estimate, not AWS '
            'billing, and is secondary: it moves with cache hits from other sessions. Failed or incomplete work '
            'is excluded from metrics: less usage there is not an efficiency win. `skill` shows how the agent '
            'reached the installed aws-blocks skill.')
DESCRIPTIVE_NOTE = ('† Descriptive, not comparable across arms: new input (uncached input + cache writes) and '
                    'cache read depend on prompt-cache warm-up order, so no difference is reported for them.')


def render_single(arms):
    results = {arm: arms[arm][1] for arm in ARMS}
    lines = header('One todo-app trajectory per arm; **n=1, not a statistical performance claim**. '
                   'Local mock mode only; nothing is deployed.')
    for arm, result in results.items():
        if not result:
            lines.append(f'- **{arm}: NO RESULT** (setup, cancellation or infrastructure failure).')
            continue
        continuity = 'verified' if result.get('same_session') is True else 'not verified'
        lines.append(f'- **{arm}: {run_status(result)}**; session continuity {continuity}; '
                     f'storage: {storage_of(result)}.')
    lines.append('')
    if all(results.values()):
        lines += packages_note(results.values())
    stores = {storage_of(result) for result in results.values() if result}
    if len(stores) > 1:
        lines += ['The arms built on different storage blocks, which moves cost by itself: this pair compares '
                  'two designs, not only the change.', '']
    lines += failures(arms, numbered=False)
    lines += ['### Candidate − baseline', '',
              '| Phase | Baseline | Candidate | Comparable | ' + ' | '.join(f'{label} Δ' for label, _ in COLUMNS) + ' |',
              '|---|---|---|---|' + '---:|' * len(COLUMNS)]
    phases = {arm: phase_map(results[arm]) for arm in ARMS}
    for name in PHASES:
        pair = [phases[arm].get(name, {}) for arm in ARMS]
        lines.append(row(name, eligible_pair(list(results.values()), name),
                         [measurements(p) for p in pair], [outcome(p) for p in pair]))
    whole = all(result and result.get('status') == 'passed' for result in results.values())
    lines.append(row('**total**', whole, [totals(phases[arm]) for arm in ARMS],
                     [(results[arm] or {}).get('status', 'missing') for arm in ARMS]))
    lines += ['', 'Δ is candidate − baseline (percent of baseline). Rows marked not comparable include '
              'failed or incomplete work. ' + FOOTNOTE]
    return '\n'.join(lines) + '\n'


def rate_text(entry):
    if not entry['n']:
        return '—'
    text = f'{entry["passes"]}/{entry["n"]}'
    if entry['n'] < 2:
        return text
    low, high = entry['wilson']
    return f'{text} ({100 * entry["rate"]:.0f}%; {100 * low:.0f}–{100 * high:.0f}%)'


def spread_text(metric, key):
    if not metric['n']:
        return '—'
    if metric['n'] == 1:
        return value_text(metric['median'], key)
    return f'{value_text(metric["median"], key)} ({value_text(metric["q1"], key)}–{value_text(metric["q3"], key)})'


def difference_text(entry, key):
    if not entry['comparable']:
        return f'not comparable ({min(entry["n"])} passes)'
    percent = f' ({entry["percent"]:+.1f}%)' if entry['percent'] is not None else ''
    return (f'{value_text(entry["difference"], key, signed=True)}{percent} '
            f'[{value_text(entry["low"], key, signed=True)}, {value_text(entry["high"], key, signed=True)}]')


def storage_section(strata):
    if not strata:
        return []
    lines = ['### Storage block', '',
             '| Storage | Baseline trials | Candidate trials | Baseline cache-neutral cost | '
             'Candidate cache-neutral cost | Candidate − baseline |', '|---|---:|---:|---:|---:|---:|']
    for name, stratum in strata.items():
        medians = [f'{value_text(stratum[arm]["median"], PRIMARY)} ({stratum[arm]["passes"]} passed)'
                   if stratum[arm]['passes'] else '—' for arm in ARMS]
        lines.append(f'| {name} | {stratum["baseline"]["trials"]} | {stratum["candidate"]["trials"]} | '
                     + ' | '.join(medians) + f' | {difference_text(stratum["difference"], PRIMARY)} |')
    return lines + ['', 'The storage block the create phase constructed, read from its snapshot. It moves cost by '
                    'itself, so a different storage mix between arms shifts the pooled medians above. Costs here '
                    'are whole-run medians over trials that passed every phase; a difference is shown only when '
                    f'both arms have at least {MIN_COMPARABLE} such passes in that storage.']


def render_trials(arms, summary):
    count = summary['trials']
    lines = header(f'{count} todo-app trajectories per arm. Pass rates carry Wilson 95% intervals; metric '
                   'differences are candidate − baseline medians over passed phases with a seeded bootstrap '
                   f'95% interval, shown only when both arms have at least {MIN_COMPARABLE} passes. The primary '
                   'metric is cache-neutral cost; the storage section compares arms within one storage block. '
                   'Local mock mode only; nothing is deployed.')
    for arm in ARMS:
        entry = summary['arms'][arm]
        notes = [f'{len(entry[key])} {label} (trial {", ".join(map(str, entry[key]))})'
                 for key, label in (('missing', 'without result'), ('infrastructure_error', 'infrastructure error'))
                 if entry[key]]
        total = entry['phases'][TOTAL]
        lines.append(f'- **{arm}**: {total["passes"]}/{total["n"]} counted trials passed every phase'
                     + (f'; {"; ".join(notes)}, excluded' if notes else '') + '.')
    lines.append('')
    present = {arm: [result for result in results.values() if result and result.get('packages')]
               for arm, results in arms.items()}
    if all(present.values()):
        lines += packages_note([result for results in present.values() for result in results])
    lines += ['<details><summary>Trials</summary>', '', '| Trial | Baseline | Candidate |', '|---:|---|---|']
    for trial in range(1, count + 1):
        lines.append(f'| {trial} | ' + ' | '.join(run_status(arms[arm].get(trial)) for arm in ARMS) + ' |')
    lines += ['', '</details>', '']
    lines += failures(arms, numbered=True)
    names = (*PHASES, TOTAL)
    lines += ['### Pass rate', '', '| Phase | Baseline | Candidate | Baseline skill | Candidate skill |',
              '|---|---:|---:|---|---|']
    for name in names:
        phases = [summary['arms'][arm]['phases'][name] for arm in ARMS]
        skills = [', '.join(f'{use} {count}' for use, count in p.get('skill_use', {}).items()) or '—' for p in phases]
        lines.append(f'| {name} | ' + ' | '.join([*(rate_text(p) for p in phases), *skills]) + ' |')
    lines += ['', '### Passed-phase medians (IQR)', '',
              '| Phase | Arm | ' + ' | '.join(label for label, _ in METRICS) + ' |',
              '|---|---|' + '---:|' * len(METRICS)]
    for name in names:
        for arm in ARMS:
            metrics = summary['arms'][arm]['phases'][name]['metrics']
            lines.append(f'| {name} | {arm} | ' + ' | '.join(spread_text(metrics[key], key) for _, key in METRICS) + ' |')
    lines += ['', DESCRIPTIVE_NOTE, '', '### Candidate − baseline', '',
              '| Phase | ' + ' | '.join(f'{label} Δ' for label, _ in COLUMNS) + ' |',
              '|---|' + '---:|' * len(COLUMNS)]
    for name in names:
        lines.append(f'| {name} | ' + ' | '.join(difference_text(summary['differences'][name][key], key)
                                                for _, key in COLUMNS) + ' |')
    lines += ['', 'Δ is the difference of medians (percent of the baseline median) [bootstrap 95% interval]. '
              'A phase passes when it and every earlier phase passed with complete accounting in one session. '
              'Trials without a result or with an infrastructure error are excluded from rates. ' + FOOTNOTE, '']
    lines += storage_section(summary['storage'])
    return '\n'.join(lines) + '\n'


def render(root, trials=None):
    arms = load_trials(Path(root), trials)
    if len(arms['baseline']) == 1:
        return render_single(arms)
    return render_trials(arms, aggregate(arms))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('results', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--trials', type=parse_trials, help='requested trials per arm (missing ones are listed)')
    args = parser.parse_args()
    args.output.write_text(render(args.results, args.trials))
