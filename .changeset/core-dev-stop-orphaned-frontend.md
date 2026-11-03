---
"@aws-blocks/core": patch
---

fix(core): `cdk-blocks dev stop` stops the frontend that a killed dev server left running

After a SIGKILL of the dev server's process group (a tool timeout, the OOM killer), its frontend dev server (Vite, `next dev`), which runs in a process group of its own, survives and keeps the frontend port. `cdk-blocks dev stop` then found the dev server gone, reported `nothing to stop`, and deleted the pidfile, which recorded that frontend group: the next `cdk-blocks dev`, which could have reclaimed the port with it, failed with `port 3100 is in use by pid …` and no command to run. Stop, then start, the natural recovery, was the one that wedged.

- `stopDevServer()` stops the recorded frontend group when the dev server is gone and that group still holds the frontend port, with the same ownership test a start uses to reclaim it, then clears the record. It reports `via: "frontend"` with the group and port as `frontend`, and `The dev server on :3000 had already stopped; stopped the frontend that this app's dev server left running on :3100 (pid …)`. A frontend port held by any other process is left alone.
- When a port stays taken at startup, the message ends with an exact command: `Stop it with \`kill <pid>\`, then run \`npx --no -- cdk-blocks dev\` again, or choose another port with --frontend-port.` (`lsof -i :<port>` when the holder's pid can't be read). New export from the dev-server module: `portInUseHint()`.
