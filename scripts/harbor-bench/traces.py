"""Pack one trial's raw evidence with the model credentials redacted; build its private S3 prefix.

Values are never printed. Redaction is exact byte replacement, so binary files are scanned
without decoding and files without a match are packed byte-identical. Verifier snapshot
tarballs are unpacked and redacted member by member, because compression hides plain bytes.
"""
import argparse
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

from trials import MAX_TRIALS

ARMS = ('baseline', 'candidate')
CREDENTIALS = ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN')
# Raw Harbor output: driver log, job config and identity, jobs dir (agent logs, Claude stream,
# trajectory, verifier logs and snapshots) and the public result. Not the copied task/registry.
INCLUDE = ('harbor.log', 'identity.json', 'job.json', 'jobs', 'public')
NESTED = ('.tar.gz', '.tgz')


def secrets_from_env(env=None):
    env = os.environ if env is None else env
    return {name: env[name] for name in CREDENTIALS if env.get(name)}


def redact(data, secrets, counts):
    # Longest first, so a value that contains another is replaced whole.
    for name, value in sorted(secrets.items(), key=lambda item: -len(item[1])):
        token = value.encode()
        found = data.count(token)
        if found:
            data = data.replace(token, f'[REDACTED:{name}]'.encode())
            counts[name] = counts.get(name, 0) + found
    return data


def redact_name(name, secrets, counts):
    return redact(name.encode(), secrets, counts).decode('utf-8', 'surrogateescape')


def redact_tarball(data, secrets, counts):
    """Redact each member of a gzip tarball; unreadable archives fall back to raw bytes."""
    output = io.BytesIO()
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source, \
                tarfile.open(fileobj=output, mode='w:gz') as target:
            for member in source:
                if not (member.isfile() or member.isdir() or member.issym()):
                    continue
                copy = tarfile.TarInfo(redact_name(member.name, secrets, counts))
                copy.mode, copy.mtime, copy.type = member.mode, member.mtime, member.type
                if member.issym():
                    copy.linkname = redact_name(member.linkname, secrets, counts)
                if member.isfile():
                    content = redact(source.extractfile(member).read(), secrets, counts)
                    copy.size = len(content)
                    target.addfile(copy, io.BytesIO(content))
                else:
                    target.addfile(copy)
    except (tarfile.TarError, OSError, EOFError):
        return redact(data, secrets, counts)
    return output.getvalue()


def entries(work):
    for name in INCLUDE:
        top = work / name
        if not os.path.lexists(top):
            continue
        yield top
        if top.is_dir() and not top.is_symlink():
            for directory, dirs, files in os.walk(top, followlinks=False):
                dirs.sort()
                for child in sorted(dirs) + sorted(files):
                    yield Path(directory) / child


def pack(work, output, secrets):
    """Write a redacted trace tarball; return counts only (never values or file contents)."""
    work = Path(work)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    counts = {}
    summary = {'files': 0, 'skipped_links': 0, 'skipped_special': 0, 'unreadable': 0}
    with tarfile.open(output, 'w:gz') as archive:
        for path in entries(work):
            info = path.lstat()
            arcname = redact_name(path.relative_to(work).as_posix(), secrets, counts)
            member = tarfile.TarInfo(arcname)
            member.mtime = int(info.st_mtime)
            if stat.S_ISLNK(info.st_mode):
                summary['skipped_links'] += 1  # Agent-created links may point outside the trace.
            elif stat.S_ISDIR(info.st_mode):
                member.type, member.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(member)
            elif stat.S_ISREG(info.st_mode):
                try:
                    data = path.read_bytes()
                except OSError:
                    summary['unreadable'] += 1
                    continue
                data = (redact_tarball if path.name.endswith(NESTED) else redact)(data, secrets, counts)
                member.size, member.mode = len(data), 0o644
                archive.addfile(member, io.BytesIO(data))
                summary['files'] += 1
            else:
                summary['skipped_special'] += 1
        summary['redactions'] = {name: counts.get(name, 0) for name in CREDENTIALS}
        summary['credentials_redacted'] = sorted(secrets)
        manifest = (json.dumps(summary, indent=2) + '\n').encode()
        member = tarfile.TarInfo('redaction.json')
        member.size, member.mode = len(manifest), 0o644
        archive.addfile(member, io.BytesIO(manifest))
    return summary


def positive(value, label):
    if not re.fullmatch(r'[1-9][0-9]*', str(value)):
        raise ValueError(f'{label} must be a positive integer')
    return int(value)


def s3_prefix(pr, run_id, attempt, arm, trial):
    if arm not in ARMS:
        raise ValueError('arm must be baseline or candidate')
    if positive(trial, 'trial') > MAX_TRIALS:
        raise ValueError(f'trial must be at most {MAX_TRIALS}')
    return (f'harbor/v1/pr={positive(pr, "pr")}/run={positive(run_id, "run")}'
            f'/attempt={positive(attempt, "attempt")}/arm={arm}/trial={int(trial)}/')


def upload_policy(bucket, prefix):
    """Inline session policy limiting one trial's writer session to its own key prefix.

    The writer role may put anywhere under harbor/v1/ and the bucket is unversioned, so without this
    a job could overwrite another run's trace.
    """
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise ValueError('bucket must be an S3 bucket name')
    if not re.fullmatch(r'harbor/v1/(?:[a-z]+=[A-Za-z0-9]+/){5}', prefix):
        raise ValueError('prefix must come from s3_prefix')
    return json.dumps({'Version': '2012-10-17', 'Statement': [{
        'Effect': 'Allow', 'Action': 's3:PutObject', 'Resource': f'arn:aws:s3:::{bucket}/{prefix}*'}]},
        separators=(',', ':'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    packer = commands.add_parser('pack', help='redact credentials from the environment and pack WORK')
    packer.add_argument('work', type=Path)
    packer.add_argument('output', type=Path)
    target = commands.add_parser('upload-target',
                                 help="print one trial's S3 key prefix and writer session policy as JSON")
    for option in ('--pr', '--run-id', '--attempt', '--arm', '--trial', '--bucket'):
        target.add_argument(option, required=True)
    args = parser.parse_args()
    if args.command == 'pack':
        # Counts are recorded as redaction.json inside the archive; nothing derived from the values is printed.
        pack(args.work, args.output, secrets_from_env())
        sys.exit()
    try:
        key = s3_prefix(args.pr, args.run_id, args.attempt, args.arm, args.trial)
        print(json.dumps({'prefix': key, 'policy': upload_policy(args.bucket, key)}))
    except ValueError as error:
        sys.exit(str(error))
