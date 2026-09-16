---
"@aws-blocks/core": minor
"@aws-blocks/create-blocks-app": patch
---

Emit a machine-readable completion signal at the end of a successful `npm run deploy`.

`deploy()` now prints one stable last line — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`) — so a caller (a coding agent, a CI step, a script) can detect "deploy finished + where it lives" by grepping one line instead of parsing streamed CloudFormation output or polling the stack for the URL. The existing human-readable `✅ Deployment complete!` / `📡 API URL` / `🌐 Frontend URL` lines are unchanged; the signal is additive. The formatting is extracted into a pure `formatDeploySignal()` helper with unit coverage. The scaffolded `AGENTS.md` documents the line so agents grep it rather than poll.
