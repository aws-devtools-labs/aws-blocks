"""Exercise the real browser verifier against a clean app, an app whose label list shares the
Labels input's accessible name, and two targeted defects; check that an agent user can launch the
preinstalled Chromium with no Playwright environment; then run the root verifier on an
unprovenanced app to check that it still writes a phase snapshot.

Uses an already built benchmark image. Does not invoke a model or AWS.
"""
import argparse
import json
from pathlib import Path
import subprocess


def run(image):
    root = Path(__file__).resolve().parent
    for bug, expected in [('', None), ('label-list', None), ('completion', 'complete_todo'),
                          ('labels', 'normalize_labels')]:
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
        print(f'{bug or "clean delayed-checkbox app"}: verified')
    agent_browser(image)
    snapshot(image, root)


def agent_browser(image):
    # The image exports no Playwright variable; the shared module alone locates the browser and
    # leaves the environment as it found it.
    script = (
        "import { chromium } from '/opt/playwright/index.mjs';"
        "const browser = await chromium.launch();"
        "const page = await browser.newPage();"
        "await page.setContent('<title>ok</title>');"
        "console.log(JSON.stringify({ title: await page.title(),"
        " env: Object.keys(process.env).filter(k => k.startsWith('PLAYWRIGHT')) }));"
        "await browser.close();"
    )
    process = subprocess.run([
        'docker', 'run', '--rm', '--user', 'node', image, 'node', '--input-type=module', '-e', script,
    ], capture_output=True, text=True, timeout=60)
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout.splitlines()[-1]) == {'title': 'ok', 'env': []}, process.stdout
    print('agent user launches preinstalled Chromium without Playwright environment')


def snapshot(image, root):
    # No registry ledger: provenance fails first, which must not prevent the snapshot.
    process = subprocess.run([
        'docker', 'run', '--rm', '-v', f'{root / "task/tests"}:/tests:ro', image, 'bash', '-c',
        'set -e; app=/app/todo-app; mkdir -p /logs/verifier "$app/node_modules/pkg" '
        '"$app/aws-blocks/node_modules/nested" "$app/.bb-data/app-todos"; '
        'echo "{}" > "$app/package-lock.json"; echo stale > "$app/node_modules/pkg/index.js"; '
        'echo stale > "$app/aws-blocks/node_modules/nested/index.js"; '
        'echo "{\\"1\\":{\\"title\\":\\"survival-a\\"}}" > "$app/.bb-data/app-todos/store.json"; '
        'echo "{\\"items\\":[{\\"title\\":\\"survival-a\\"}]}" > /var/lib/harbor-verifier/state.json; '
        'BENCH_PHASE=2 python3 /tests/verify.py 2>/dev/null || true; '
        'python3 -c \'import json, tarfile; print(json.dumps({'
        '"verification": json.load(open("/logs/verifier/verification.json")), '
        '"members": tarfile.open("/logs/verifier/snapshot.tar.gz").getnames()}))\'',
    ], capture_output=True, text=True, timeout=120)
    assert process.returncode == 0, process.stderr
    output = json.loads(process.stdout.splitlines()[-1])
    verification, members = output['verification'], set(output['members'])
    assert verification['status'] == 'failed', verification
    assert verification['failure']['stage'] == 'package_provenance', verification
    assert verification['snapshot'] is True, verification
    assert {'todo-app/package-lock.json', 'todo-app/.bb-data/app-todos/store.json',
            'verifier-state.json'} <= members, members
    assert not any('node_modules' in name for name in members), members
    print(f'phase snapshot on verifier failure: {len(members)} entries, no node_modules')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    run(parser.parse_args().image)
