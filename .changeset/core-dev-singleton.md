---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): a second dev server on the same port exits with an error instead of hanging, and two simultaneous starts no longer fight

- Starting a second `blocks dev` in an app whose dev server already runs on that port used to print "already running" and then hang under `tsx watch`, out of reach of `blocks dev stop`. The same hang followed any startup failure, such as `EACCES` on the port or a port that stayed in use. Now the dev server prints the reason, stops its `tsx watch` parent, and exits with code 1. The message names `blocks dev stop` (with `--port` when the port isn't 3000), not `npm run dev:stop`.
- When `BLOCKS_DEV_FAILURE_FILE` is set, the dev server also writes the one-line reason to that file, so a caller can tell a failed start from a requested stop.
- The per-port pidfile in `.blocks-sandbox/` is now created exclusively. When two dev servers start at the same moment on one port, exactly one runs and the other exits; before, both passed the check and the second killed the first. The pidfile also records each process's command line, so a pid the OS has reused no longer counts as a running dev server, and a dev server that is between two reloads still counts as running.
