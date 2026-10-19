---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

fix(telemetry): a global opt-out is no longer overridden by a project config that enables telemetry

When `~/.blocks/config.json` disabled telemetry (for example after `blocks-telemetry --disable --global`) and the project's `.blocks/config.json` had `telemetry.enabled: true`, events were still sent even though `blocks-telemetry --status` reported telemetry as disabled. Because `.blocks/config.json` is usually committed, one contributor running `--enable` in a project could switch telemetry back on for everyone who had opted out globally.

Any opt-out now wins: the `AWS_BLOCKS_DISABLE_TELEMETRY` env var, a project config with `telemetry.enabled: false`, or a global config with `telemetry.enabled: false` each disables telemetry, whatever another config says. `blocks-telemetry --status` and event collection now apply the same rule, so they always agree. `create-blocks-app` follows the same rule.
