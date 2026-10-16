"""Exercise the real browser verifier against a clean app and two targeted defects.

Uses an already built benchmark image. Does not invoke a model or AWS.
"""
import argparse
import json
from pathlib import Path
import subprocess


def run(image):
    root = Path(__file__).resolve().parent
    for bug, expected in [('', None), ('completion', 'complete_todo'), ('labels', 'normalize_labels')]:
        process = subprocess.run([
            'docker', 'run', '--rm', '-e', f'BUG={bug}',
            '-v', f'{root / "task/tests"}:/tests:ro',
            '-v', f'{root / "fixtures/reference.mjs"}:/tmp/fixture.mjs:ro',
            image, 'bash', '-lc',
            'mkdir -p /logs/verifier; node /tmp/fixture.mjs & pid=$!; '
            'trap "kill $pid" EXIT; '
            'for i in {1..30}; do curl -fsS http://localhost:3000 >/dev/null && break; sleep 0.1; done; '
            'for phase in 1 2 3; do BENCH_PHASE=$phase node /tests/ui.mjs exercise; code=$?; '
            'cat /logs/verifier/ui-exercise.json; echo; if [ $code -ne 0 ]; then exit $code; fi; '
            'kill $pid; wait $pid; node /tmp/fixture.mjs & pid=$!; '
            'for i in {1..30}; do curl -fsS http://localhost:3000 >/dev/null && break; sleep 0.1; done; '
            'BENCH_PHASE=$phase node /tests/ui.mjs survival || exit $?; done',
        ], capture_output=True, text=True, timeout=150)
        diagnostics = [json.loads(line) for line in process.stdout.splitlines() if line.startswith('{')]
        if expected is None:
            assert process.returncode == 0, process.stderr
            assert len(diagnostics) == 3
            assert all(d['status'] == 'passed' for d in diagnostics)
        else:
            assert process.returncode != 0
            assert diagnostics[-1]['failure']['check'] == expected, diagnostics
            assert diagnostics[-1]['failure']['reason'] == 'value_mismatch', diagnostics
        print(f'{bug or "clean delayed-checkbox app"}: verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    run(parser.parse_args().image)
