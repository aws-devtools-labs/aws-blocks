---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat(create-blocks-app): add a dev:stop command for the local dev server

Adds a first-class, sanctioned way to stop the local dev server, so there is an
alternative to `pkill -f tsx` / `killall node` — which match by process name and
can kill the caller's own shell/agent process.

- `@aws-blocks/core/scripts` (re-exported by `@aws-blocks/blocks/scripts`) gains
  `stopDevServer`, the CLI entry `runStopCli`, `stopMessage`, and the
  `StopResult` type. Stop acts ONLY on the supervisor identity the dev server
  recorded in its own pidfile (`{pid, ppid, port}`): it SIGTERMs the recorded
  `tsx watch` watcher — the only thing that actually ends `npm run dev` — and
  falls back to the recorded child's listener tree only when the watcher is
  gone. It never scans a port and signals an arbitrary listener, so a stale
  pidfile or an unrelated same-port process is never touched, and the pidfile is
  removed only once the port is confirmed free. Idempotent; never throws;
  `runStopCli` exits non-zero when the stop leaves the port bound.

- `@aws-blocks/create-blocks-app`: every standalone template gains a `dev:stop`
  npm script and a thin `stop.ts` wrapper; the existing-project and Amplify
  integration paths get `dev:stop` / `blocks:stop` too. The scaffolded
  `AGENTS.md` and the singleton-guard message point at `npm run dev:stop`
  instead of `pkill` / the blunt cleanup script.
