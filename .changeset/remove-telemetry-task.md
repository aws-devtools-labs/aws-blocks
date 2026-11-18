---
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': minor
---

**Breaking: the `telemetry` app task is gone.** A scaffolded app no longer gets a `"telemetry"` package script, and `npm run migrate` no longer adds one, so `npm run telemetry` in a new or migrated app fails with npm's "Missing script" error.

The task ran the `telemetry` command, which is removed along with `AWS_BLOCKS_DISABLE_TELEMETRY`, the `blocks-telemetry` binary and the `telemetry.enabled` key in `.blocks/config.json`. Telemetry now follows your CDK CLI telemetry setting: opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.

13 of the 14 `create-blocks-app` templates shipped the script and no longer do, and the example `package.json` in the create-blocks-app README no longer lists it. The `amplify` template is an overlay and defines no `scripts` of its own, so it never had it. An existing app keeps the script it was scaffolded with; `npm run migrate` does not remove it.
