---
"@aws-blocks/blocks": patch
---

fix(blocks): `blocks` output streams, non-interactive runs and usage errors

- `--no-input` and `CI` reach `blocks secret`, `blocks config` and `blocks db pull`: a value prompt that the run cannot show is a usage error (exit 2) naming `--value-stdin`, even on a terminal. A missing key, an unknown subcommand, a missing flag value, an unknown `db` verb (with a suggestion) and an unconfirmed `secret remove --force` also exit 2. The global `--yes` confirms `secret remove --force`, as `--yes` after the command does.
- `--quiet` does not hide the dev server's RPC errors; it sets only `BLOCKS_LOG_LEVEL=quiet`. A `BLOCKS_DEV_QUIET` you set yourself still applies.
- Text output: the CLI runs core with `BLOCKS_LOG_STREAM=stderr`, so progress, CDK milestones, raw CDK output and streamed CloudFormation events go to stderr, and stdout keeps the deployment target, `BLOCKS_DEPLOYED` and the final URLs. `blocks generate spec` follows it too: its progress lines go to stderr, and stdout keeps the `✅ OpenRPC spec written to …` line.
- `blocks deploy` and `blocks sandbox deploy` print no JSON or `--query` result after a failed or interrupted run. The result comes from `.blocks-sandbox/last-deploy.json`, which the deploy runner writes: the stack outputs core read when it deployed, so a concurrent deploy of the other stage that rewrites `.blocks-sandbox/outputs.json` cannot change or empty it, and the account and Region the deploy itself used. When the runner recorded no result, the command exits 1 with an error instead of printing null fields.
- A closed terminal no longer makes `blocks deploy` exit 1 while the deploy goes on: the runners other than the dev server run as `node --import` with the `tsx` loader, with no `tsx` process between the CLI and the runner, and the CLI reports the deploy's own exit code and result.
- Arguments after `--` are rejected with exit 2 (`unexpected arguments after --`) for commands that do not forward them, instead of being dropped.
- `--telemetry-file <path>` (or `--telemetry-file=<path>`) is a global option. The CLI passes it, as an absolute path, to the lifecycle runners, where core's telemetry client reads it, so `npm run dev -- --telemetry-file=/tmp/events.json` captures events as it did with the scripts.
- `blocks sandbox --deploy-only` runs `blocks sandbox deploy`, as a hidden alias of the old script flag.
- `package.json` `"blocks": { "dev": { "frontend": false } }` runs the backend only, as `--no-frontend` does, even when `vite` or `next` is installed. It cannot be combined with `frontendCommand` or `frontendPort`.
- A `--host` or `blocks.dev.host` is also exported to the dev server as `BLOCKS_DEV_HOST`, so the local realtime WebSocket (`/realtime`) accepts that host's origins, as it does for a `BLOCKS_DEV_HOST` you set yourself; a `BLOCKS_DEV_HOST` already in the environment is kept.
- A `package.json` that starts with a UTF-8 byte order mark is read as npm reads it, so `blocks dev`, `blocks dev stop` and the sandbox commands accept it instead of failing with `cannot read …/package.json`.
