---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): stopping `cdk-blocks dev` no longer leaves its pidfile behind

The dev server keeps its pidfile on the SIGTERM that `tsx watch` restarts it with, so a `dev stop` right after an edit still finds it. A stop sends the same SIGTERM: the `cdk-blocks` CLI signals the dev server and then its `tsx watch`, and `tsx watch` relays a SIGTERM it receives. Each of these stops left `.blocks-sandbox/dev-server.<port>.pid` naming a process that had exited.

- On that SIGTERM, the dev server now starts a small detached watcher. When `tsx watch` exits while the pidfile still names the old dev server, the watcher removes the pidfile.
- On a reload, the successor takes the pidfile over and the watcher exits. The watcher also exits after ten minutes at most.
