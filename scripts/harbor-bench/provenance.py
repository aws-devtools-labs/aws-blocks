"""Verify lock integrity AND installed package bytes against this arm's tarballs."""
import hashlib
import json
import os
from pathlib import Path
import tarfile


def verify(registry=Path('/opt/registry'), app=Path('/app/todo-app'),
           ledger=Path('/var/lib/harbor-verifier/registry-requests.jsonl')):
    manifest = json.loads((registry / 'publish-manifest.json').read_text())
    packages = {p['name']: p for p in manifest['packages']}
    requests = [json.loads(line)['path'] for line in ledger.read_text().splitlines()]
    # However the agent invoked it (npm create, npx, a local install), the scaffolder can
    # only have come from this run's registry: @aws-blocks has no public fallback.
    scaffolder = packages['@aws-blocks/create-blocks-app']['tarballS3Key']
    assert '/' + scaffolder in requests, 'scaffolder was not served by this run registry'
    lock = json.loads((app / 'package-lock.json').read_text())
    checked = []
    for location, entry in lock['packages'].items():
        name = location.rsplit('node_modules/', 1)[-1]
        if not name.startswith('@aws-blocks/') or name.count('/') != 1:
            continue
        assert not entry.get('link'), f'workspace link: {location}'
        expected = packages[name]
        assert entry.get('integrity') == expected['integrity'], f'wrong integrity: {name}'
        assert entry.get('version') == expected['version'], f'wrong version: {name}'
        url = 'http://localhost:4873/' + expected['tarballS3Key']
        assert entry.get('resolved') == url, f'wrong registry: {name}'
        assert '/' + expected['tarballS3Key'] in requests, f'tarball not served: {name}'
        installed = app / location
        assert not installed.is_symlink(), f'workspace link: {name}'
        with tarfile.open(registry / expected['tarballS3Key']) as archive:
            count = 0
            for member in archive:
                if not member.isfile():
                    continue
                relative = Path(member.name).relative_to('package')
                assert '..' not in relative.parts
                path = installed / relative
                assert path.resolve().is_relative_to(installed.resolve()), f'escaped file: {name}'
                assert path.read_bytes() == archive.extractfile(member).read(), f'modified package: {name}/{relative}'
                count += 1
        checked.append({'name': name, 'version': expected['version'],
                        'integrity': expected['integrity'], 'files': count})
    for required in ('@aws-blocks/blocks', '@aws-blocks/core'):
        assert any(p['name'] == required for p in checked), required
    sources = '\n'.join(p.read_text() for p in (app / 'aws-blocks').rglob('*.ts') if 'node_modules' not in p.parts)
    # Persistence is a separate verify.py heuristic: verifier records must appear under .bb-data.
    assert '@aws-blocks/' in sources and 'ApiNamespace' in sources, 'backend must expose a Blocks ApiNamespace'
    return {'status': 'passed', 'packages': checked,
            'manifest_sha256': hashlib.sha256((registry / 'publish-manifest.json').read_bytes()).hexdigest()}


def stored_in_blocks(app, titles):
    """Titles absent from every file under the app's Blocks mock data (.bb-data)."""
    missing = {title.encode() for title in titles}
    for top, dirs, files in os.walk(app):
        dirs[:] = [d for d in dirs if d != 'node_modules']
        if '.bb-data' not in Path(top).relative_to(app).parts:
            continue
        for file in files:
            if missing:
                data = (Path(top) / file).read_bytes()
                missing = {title for title in missing if title not in data}
    return sorted(title.decode() for title in missing)


if __name__ == '__main__':
    print(json.dumps(verify()))
