---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat(create-blocks-app): add dev:stop/dev:status commands for the dev server

Adds a first-class way to stop and inspect the local dev server, so there is a
sanctioned alternative to `pkill -f tsx` / `killall node` — which match by
process name and can kill the caller's own shell.

- `@aws-blocks/core/scripts` (re-exported by `@aws-blocks/blocks/scripts`) gains
  `stopDevServer`, `statusDevServer`, the port-agnostic `stopAllDevServers`, and
  the CLI entries `runStopCli` / `runStatusCli` (plus `stopMessage` /
  `statusMessage` and the `StopResult` / `StatusResult` types). Stop targets the
  listener by its OS PID (the existing `lsof` / `netstat` discovery) and reaps
  the whole process tree (SIGTERM→SIGKILL), then removes the singleton pidfile —
  reusing the machinery `startDevServer` already relies on, never a name match.
  It is idempotent (a no-op when nothing is running) and scans the
  `.blocks-sandbox` pidfiles so one wrapper fits any port. `statusDevServer` also
  probes the paired frontend port so `dev:status` and `dev:stop` describe the
  same port set (an orphaned frontend after a half-finished stop is surfaced).

- `@aws-blocks/create-blocks-app`: every standalone template gains `dev:stop` and
  `dev:status` npm scripts and the thin `stop.ts` / `status.ts` wrappers, and the
  scaffolded `AGENTS.md` points at the new commands instead of `pkill`.
