"""Verify lock integrity AND installed package bytes against this arm's tarballs."""
import hashlib
import json
from pathlib import Path
import tarfile


def verify(registry=Path('/opt/registry'), app=Path('/app'),
           ledger=Path('/var/lib/harbor-verifier/registry-requests.jsonl')):
    manifest = json.loads((registry / 'publish-manifest.json').read_text())
    packages = {p['name']: p for p in manifest['packages']}
    requests = [json.loads(line)['path'] for line in ledger.read_text().splitlines()]
    checked = []
    for project in ('bootstrap', 'todo-app'):
        base = app / project
        lock = json.loads((base / 'package-lock.json').read_text())
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
            installed = base / location
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
            checked.append({'project': project, 'name': name, 'version': expected['version'],
                            'integrity': expected['integrity'], 'files': count})
    assert any(p['project'] == 'bootstrap' and p['name'] == '@aws-blocks/create-blocks-app' for p in checked)
    for required in ('@aws-blocks/blocks', '@aws-blocks/core'):
        assert any(p['project'] == 'todo-app' and p['name'] == required for p in checked), required
    backend = app / 'todo-app' / 'aws-blocks'
    sources = '\n'.join(p.read_text() for p in backend.rglob('*.ts') if 'node_modules' not in p.parts)
    assert '@aws-blocks/' in sources and 'ApiNamespace' in sources, 'backend must consume Blocks RPC'
    assert any(name in sources for name in ('KVStore', 'DistributedTable', 'Database')), 'must use Blocks persistence'
    return {'status': 'passed', 'packages': checked,
            'manifest_sha256': hashlib.sha256((registry / 'publish-manifest.json').read_bytes()).hexdigest()}


if __name__ == '__main__':
    print(json.dumps(verify()))
