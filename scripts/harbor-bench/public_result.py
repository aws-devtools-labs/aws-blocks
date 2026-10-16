"""Never publish raw Harbor logs, trajectories, generated app files, or exception text."""
import json

from accounting import events
from diagnostics import public_diagnostics, count
from discovery import CATEGORIES

PHASES = ('create', 'due-dates', 'labels')
TOOLS = {'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Skill', 'ToolSearch'}


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def numeric(value):
    return value if type(value) in (int, float) and value >= 0 else None


def collect(work, identity, exit_code, error):
    result = {
        'schema': 1, 'arm': identity['arm'], 'commit': identity['commit'],
        'status': 'infrastructure_error', 'harbor_exit_code': exit_code,
        'error': error, 'model': 'global.anthropic.claude-opus-5-5',
        'harbor_revision': '09f5b964f8e5075f7e52fd08c9994dfc80ad5d24',
        'claude_version': '2.1.296', 'skill_revision': identity['skill_revision'],
        'packages': identity['packages'], 'phases': [],
        'harness_commit': identity.get('harness_commit'),
    }
    trials = list((work / 'jobs' / identity['arm']).glob('*/result.json'))
    if len(trials) != 1:
        return result
    trial_path = trials[0]
    trial = load(trial_path) or {}
    steps = {step['step_name']: step for step in trial.get('step_results') or []}
    session_ids = set()
    for name in PHASES:
        step = steps.get(name)
        if not step:
            result['phases'].append({'name': name, 'status': 'not_run'})
            continue
        agent = step.get('agent_result') or {}
        metrics = (agent.get('metadata') or {}).get('harbor_bench') or {}
        if metrics.get('session_id'):
            session_ids.add(metrics['session_id'])
        step_dir = trial_path.parent / 'steps' / name
        verification = load(step_dir / 'verifier' / 'verification.json') or {}
        ui_results = {mode: data for mode in ('exercise', 'survival')
                      if (data := load(step_dir / 'verifier' / f'ui-{mode}.json')) is not None}
        accounting_ok = bool(metrics) and not metrics.get('accounting_errors')
        checks = {key: verification.get('checks', {}).get(key) is True for key in
                  ('package_provenance', 'build', 'all_phases_and_reload', 'server_restart_fresh_browser')}
        success = (not step.get('exception_info') and metrics.get('is_error') is False
                   and metrics.get('subtype') == 'success' and accounting_ok
                   and verification.get('status') == 'passed' and all(checks.values()))
        if name == 'create' and (metrics.get('scaffolder_command_observed') is not True
                                 or metrics.get('instructions_read_observed') is not True):
            success = False
        phase = {
            'name': name, 'status': 'passed' if success else 'failed',
            'agent_completed': metrics.get('subtype') == 'success' and metrics.get('is_error') is False,
            'verifier_passed': verification.get('status') == 'passed',
            'accounting_complete': accounting_ok,
            'scaffolder_observed': metrics.get('scaffolder_command_observed') is True if name == 'create' else None,
            'instructions_read_observed': metrics.get('instructions_read_observed') is True if name == 'create' else None,
            'turns': numeric(metrics.get('turns')), 'tool_calls': numeric(metrics.get('tool_calls')),
            'llm_calls': numeric(metrics.get('llm_calls')), 'duration_ms': numeric(metrics.get('duration_ms')),
            'usage': {key: numeric((metrics.get('usage') or {}).get(key)) for key in
                      ('input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd')},
            'checks': checks,
            'diagnostics': public_diagnostics(verification, ui_results),
            'discovery': {key: count((metrics.get('discovery') or {}).get(key))
                          for key in (*CATEGORIES, 'failed_tools', 'observed_tools')},
        }
        result['phases'].append(phase)
        # Safe trace: tool shape/count/timing evidence, NOT prompts, commands, outputs, IDs, or paths.
        stream_path = step_dir / 'agent' / 'claude-code.txt'
        trace = []
        for event in events(stream_path.read_text(errors='replace') if stream_path.exists() else ''):
            if event.get('type') != 'assistant':
                continue
            for block in (event.get('message') or {}).get('content') or []:
                if block.get('type') == 'tool_use':
                    tool = block.get('name')
                    trace.append({'index': len(trace) + 1, 'tool': tool if tool in TOOLS else 'other'})
        (work / 'public' / f'{name}-tools.json').write_text(json.dumps(trace, indent=2))
        provenance = load(step_dir / 'verifier' / 'provenance.json')
        if provenance:
            # Package identities are validated against the already public build manifest.
            expected = {(p['name'], p['version'], p['integrity']) for p in identity['packages']}
            safe_packages = [p for p in provenance.get('packages', [])
                             if (p.get('name'), p.get('version'), p.get('integrity')) in expected]
            (work / 'public' / f'{name}-packages.json').write_text(json.dumps([
                {'project': p['project'] if p.get('project') in ('bootstrap', 'todo-app') else 'unknown',
                 'name': p['name'], 'version': p['version'], 'integrity': p['integrity'],
                 'files': numeric(p.get('files'))}
                for p in safe_packages], indent=2))
    result['same_session'] = len(session_ids) == 1 and len(steps) == 3
    result['status'] = 'passed' if (exit_code == 0 and not error and not trial.get('exception_info')
                                   and result['same_session']
                                   and all(p['status'] == 'passed' for p in result['phases'])) else 'failed'
    return result
