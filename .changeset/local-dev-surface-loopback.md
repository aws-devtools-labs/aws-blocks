---
"@aws-blocks/core": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix: the local dev surface is no longer reachable from the network or from other websites

- **Dev server binds loopback.** `npm run dev` now listens on `127.0.0.1` instead of every
  interface. It serves your whole API against local mock data with no authentication, so it
  must not be reachable from other machines. For a container or remote devbox, opt in with
  `BLOCKS_DEV_HOST=0.0.0.0` (or `startDevServer({ host })`); a warning is printed when the host
  isn't loopback.
- **Local realtime WebSocket matches the deployed one.** A client-sent `publish` was broadcast
  to every subscriber with no authorization. The deployed WebSocket has no client publish, so
  the local server now rejects it as well; publish from the server with `Realtime.publish()`.
- **Local realtime tokens are signed with a per-process random secret** instead of a constant
  published in this repository, so they can't be forged.
- **The `/realtime` WebSocket upgrade checks `Origin`.** Only loopback origins (or the
  `BLOCKS_DEV_HOST` you set) can connect. This closes cross-site WebSocket hijacking from any
  page the developer visits. Non-browser clients that send no `Origin` still connect.
- **`GET /aws-blocks/settings` opens an editor only under the local dev server.** It no longer
  spawns a process or echoes the working directory when the built-in routes run in a deployed
  Lambda, and it opens the file with `execFile` instead of a shell command.
- **The `nextjs` template's frontend dev server binds loopback** (`next dev --hostname
  127.0.0.1`), like the Blocks dev server.
