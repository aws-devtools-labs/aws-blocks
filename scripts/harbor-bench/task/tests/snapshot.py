"""Phase snapshot for later replay: the agent's app (no node_modules) and the verifier state."""
import os
from pathlib import Path
import tarfile


def _keep(member):
    # Skipping a directory here also skips walking it.
    if 'node_modules' in Path(member.name).parts:
        return None
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        return None  # Sockets, FIFOs and devices carry no replayable state.
    member.uid = member.gid = 0
    member.uname = member.gname = ''
    return member


def capture(app, state, target):
    """Write `target` atomically: todo-app/ (with .bb-data and lockfile) and verifier-state.json."""
    target = Path(target)
    partial = target.with_name(target.name + '.partial')
    with tarfile.open(partial, 'w:gz') as archive:
        if Path(app).is_dir():
            archive.add(app, arcname='todo-app', filter=_keep)
        if Path(state).is_file():
            archive.add(state, arcname='verifier-state.json', filter=_keep)
    os.replace(partial, target)
