"""Never publish raw Harbor logs, trajectories, generated app files, or exception text."""
import json

from accounting import tool_uses
from diagnostics import public_failure
from pins import CLAUDE_VERSION, HARBOR_REVISION, MODEL

PHASES = ('create', 'due-dates', 'labels')
TOOLS = {'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Skill', 'ToolSearch'}
CHECKS = ('package_provenance', 'build', 'all_phases_and_reload', 'blocks_persistence',
          'server_restart_fresh_browser')
SKILL_USE = ('skill_tool', 'file_read', 'none')


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def numeric(value):
    return value if type(value) in (int, float) and value >= 0 else None


def collect(work, identity, exit_code, error):
    result = {
        'schema': 2, 'arm': identity['arm'], 'commit': identity['commit'],
        'status': 'infrastructure_error', 'harbor_exit_code': exit_code,
        'error': error, 'model': MODEL, 'harbor_revision': HARBOR_REVISION,
        'claude_version': CLAUDE_VERSION, 'skill_revision': identity['skill_revision'],
        'packages': identity['packages'], 'phases': [],
        'harness_commit': identity.get('harness_commit'),
    }
    trials = list((work / 'jobs' / identity['arm']).glob('*/result.json'))
    if len(trials) != 1:
        return result
    trial_path = trials[0]
    trial = load(trial_path) or {}
    steps = {step['step_name']: step for step in trial.get('step_results') or []}
    session_ids = []  # One entry per executed step; Harbor stops after a failed gated phase.
    for name in PHASES:
        step = steps.get(name)
        if not step:
            result['phases'].append({'name': name, 'status': 'not_run'})
            continue
        agent = step.get('agent_result') or {}
        metrics = (agent.get('metadata') or {}).get('harbor_bench') or {}
        session_ids.append(metrics.get('session_id'))
        step_dir = trial_path.parent / 'steps' / name
        verification = load(step_dir / 'verifier' / 'verification.json') or {}
        ui_results = {mode: data for mode in ('exercise', 'survival')
                      if (data := load(step_dir / 'verifier' / f'ui-{mode}.json')) is not None}
        accounting_ok = bool(metrics) and not metrics.get('accounting_errors')
        checks = {key: verification.get('checks', {}).get(key) is True for key in CHECKS}
        agent_completed = metrics.get('subtype') == 'success' and metrics.get('is_error') is False
        success = (not step.get('exception_info') and agent_completed and accounting_ok
                   and verification.get('status') == 'passed' and all(checks.values()))
        result['phases'].append({
            'name': name, 'status': 'passed' if success else 'failed',
            'agent_completed': agent_completed,
            'verifier_passed': verification.get('status') == 'passed',
            'accounting_complete': accounting_ok,
            # Reported, never required: the skill trigger is one of the things being measured.
            'skill_use': metrics.get('skill_use') if metrics.get('skill_use') in SKILL_USE else None,
            'turns': numeric(metrics.get('turns')), 'tool_calls': numeric(metrics.get('tool_calls')),
            'llm_calls': numeric(metrics.get('llm_calls')), 'duration_ms': numeric(metrics.get('duration_ms')),
            'usage': {key: numeric((metrics.get('usage') or {}).get(key)) for key in
                      ('input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd')},
            'checks': checks,
            'failure': public_failure(verification, ui_results),
        })
        # Safe trace: tool shape/count evidence, NOT prompts, commands, outputs, IDs, or paths.
        stream_path = step_dir / 'agent' / 'claude-code.txt'
        stream = stream_path.read_text(errors='replace') if stream_path.exists() else ''
        trace = [{'index': index, 'tool': block.get('name') if block.get('name') in TOOLS else 'other'}
                 for index, block in enumerate(tool_uses(stream), 1)]
        (work / 'public' / f'{name}-tools.json').write_text(json.dumps(trace, indent=2))
        provenance = load(step_dir / 'verifier' / 'provenance.json')
        if provenance:
            # Package identities are validated against the already public build manifest.
            expected = {(p['name'], p['version'], p['integrity']) for p in identity['packages']}
            (work / 'public' / f'{name}-packages.json').write_text(json.dumps([
                {'name': p['name'], 'version': p['version'], 'integrity': p['integrity'],
                 'files': numeric(p.get('files'))}
                for p in provenance.get('packages', [])
                if (p.get('name'), p.get('version'), p.get('integrity')) in expected], indent=2))
    # Continuity covers the steps that ran; not_run phases already keep the run from passing.
    result['same_session'] = bool(session_ids) and None not in session_ids and len(set(session_ids)) == 1
    result['status'] = 'passed' if (exit_code == 0 and not error and not trial.get('exception_info')
                                   and result['same_session']
                                   and all(p['status'] == 'passed' for p in result['phases'])) else 'failed'
    return result
