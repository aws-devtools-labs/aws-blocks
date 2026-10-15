---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

feat(deploy): add `deploy:status` / `deploy:wait` so a backgrounded deploy is drivable without polling CloudFormation

A first production deploy can run 10+ minutes — longer than a typical agent/CI
shell timeout — so an agent that ran `npm run deploy` in the foreground either
blocked past its limit or fell back to polling `describe-stacks` by hand. The
signal-resilient backgrounding was already shipped (`deploy()` survives a stray
SIGTERM/SIGHUP and prints one stable terminal line: `BLOCKS_DEPLOYED url=… api=…`
on success, `❌ Deployment failed.` on failure), but there was no clean way to
ask "is it done yet?" short of tailing and grepping the log.

This adds a thin reader over those existing terminal lines:

- `npm run deploy:status` — read the deploy log once and print `✅ deployed
  url=… api=…`, `❌ failed`, or `⏳ running`, exiting `0` / `1` / `2` so a shell
  can branch on the state without parsing stdout.
- `npm run deploy:wait` — block (reading the log on a 2s interval, default 20-min
  cap) until the deploy reports done or failed, then print the final status and
  exit `0` / `1` (or `2` if it is still running at the cap). It never calls
  CloudFormation.

The agent flow becomes one deploy invocation and zero CloudFormation polls:
`npm run deploy > deploy.log 2>&1 &` then `npm run deploy:wait`. Both read the
log the backgrounded deploy writes, so they stay correct even if the original
`npm run deploy` process was reaped.

New in `@aws-blocks/core/scripts`: `parseDeployStatus`, `readDeployStatus`,
`formatDeployStatus`, `runDeployStatusCli`, `runDeployWaitCli` (and the
`DeployState` / `DeployStatus` types). The `BLOCKS_DEPLOYED` prefix and the
failure banner are now shared constants so the producer and the reader can never
drift. `@aws-blocks/create-blocks-app` templates gain the two npm scripts and a
`deploy-status.ts` wrapper, and the generated `AGENTS.md` documents the
detach→wait loop. No breaking change — existing `deploy` behaviour is untouched.
