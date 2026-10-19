"""Prepare one isolated task from an already built local registry (no model call)."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

from pins import CLAUDE_VERSION, MODEL, SKILL_REVISION, SKILL_SHA256, SKILL_URL

ROOT = Path(__file__).resolve().parent


def prepare(registry, output, arm, commit, harness_commit=None):
    output.mkdir(parents=True, exist_ok=False)
    task = output / 'task'
    shutil.copytree(ROOT / 'task', task)
    target = task / 'environment' / 'registry'
    shutil.copytree(registry, target)
    manifest = json.loads((target / 'publish-manifest.json').read_text())
    assert manifest['packages'] and not manifest.get('skipped'), 'a fresh complete registry is required'
    for package in manifest['packages']:
        tarball = target / package['tarballS3Key']
        assert tarball.resolve().is_relative_to(target.resolve())
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()
        assert integrity == package['integrity'], f'corrupt packed package: {package["name"]}'
    bench = task / 'environment' / 'bench'
    bench.mkdir()
    for name in ('registry.mjs', 'provenance.py'):
        shutil.copyfile(ROOT / name, bench / name)
    with urllib.request.urlopen(SKILL_URL, timeout=30) as response:
        skill = response.read()
    assert hashlib.sha256(skill).hexdigest() == SKILL_SHA256, 'skill content does not match pin'
    # Harbor injects this directory into Claude's skills config; the prompt never names it,
    # so whether the skill triggers is part of the measurement.
    skills = output / 'skills'
    (skills / 'aws-blocks').mkdir(parents=True)
    (skills / 'aws-blocks' / 'SKILL.md').write_bytes(skill)
    image = f'harbor-blocks-{arm}:{commit[:12]}'
    config = {
        'job_name': arm, 'jobs_dir': str(output / 'jobs'), 'n_attempts': 1,
        'n_concurrent_trials': 1, 'retry': {'max_retries': 0},
        'tasks': [{'path': str(task)}],
        'environment': {'type': 'docker', 'delete': True,
                        'extra_docker_compose': [str(output / 'hardening.yaml')]},
        'agents': [{
            'import_path': 'agent:HarborBlocksClaude',
            'model_name': MODEL, 'resume_trajectory': True,
            'override_setup_timeout_sec': 120, 'skills': [str(skills)],
            'kwargs': {'version': CLAUDE_VERSION, 'max_turns': 200,
                       'disallowed_tools': 'Agent,Task', 'disable_web_search': True},
        }],
    }
    (output / 'hardening.yaml').write_text(
        'services:\n  main:\n    security_opt:\n      - no-new-privileges:true\n'
    )
    # Prebuilt image means installing the toolchain costs no credential lifetime.
    text = (task / 'task.toml').read_text().replace('[environment]\n', f'[environment]\ndocker_image = "{image}"\n')
    (task / 'task.toml').write_text(text)
    dockerfile = task / 'environment' / 'Dockerfile'
    dockerfile.write_text(dockerfile.read_text().replace(
        'ARG CLAUDE_CODE_VERSION\n', f'ARG CLAUDE_CODE_VERSION={CLAUDE_VERSION}\n'))
    (output / 'job.json').write_text(json.dumps(config, indent=2))
    (output / 'identity.json').write_text(json.dumps({
        'arm': arm, 'commit': commit, 'image': image, 'skill_revision': SKILL_REVISION,
        'skill_sha256': SKILL_SHA256, 'packages': manifest['packages'],
        'harness_commit': harness_commit,
    }, indent=2))
    print(image)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--arm', choices=('baseline', 'candidate'), required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--harness-commit')
    args = parser.parse_args()
    prepare(args.registry.resolve(), args.output.resolve(), args.arm, args.commit, args.harness_commit)
