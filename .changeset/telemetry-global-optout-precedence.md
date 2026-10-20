---
"@aws-blocks/core": minor
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/blocks": minor
---

A project config can no longer re-enable telemetry that a global config disabled.

`isTelemetryEnabled()` returned early on a project `telemetry.enabled: true` before reading `~/.blocks/config.json`, so `blocks-telemetry --disable --global` followed by `--enable` left the send gate open while `--status` reported disabled. The gate now resolves through `getTelemetryStatus()`, so only `false` short-circuits and the two cannot disagree. `blocks-telemetry --enable` also warns, naming the mechanism, when a broader opt-out still applies. The env var already overrode both config files, and a project `false` still beats a global `true`.

Behavior change (0.x minor = breaking channel): if you globally disabled telemetry and relied on a project config to turn it back on, that project stays opted out. Re-enable globally with `npx blocks-telemetry --enable --global`.
