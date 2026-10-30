---
"@aws-blocks/core": minor
---

feat(core): honor `BLOCKS_LOG_LEVEL` and `BLOCKS_LOG_STREAM` in the lifecycle scripts

`deploy`, `destroy`, `startSandbox`, `destroySandbox` and `startDevServer` from `@aws-blocks/core/scripts` now read `BLOCKS_LOG_LEVEL`:

- unset (or any unrecognised value): output is unchanged.
- `quiet`: errors and final results only.
- `normal`: short progress steps; CDK output is condensed into milestones and a resource count, and failure and rollback lines still print.
- `verbose`: the raw CDK output, as today.
- `debug`: `verbose` plus stack traces for errors the scripts catch and report as warnings.

The `BLOCKS_DEPLOYED …` line, the deployment-target summary, the API and frontend URLs and error messages print at every level. At `quiet` and `normal` the last 500 lines of hidden CDK output are kept, and when a deploy, destroy or `cdk watch` deploy fails they are printed to stderr before the error, so the failure never needs a re-run to diagnose. A `cdk watch` deploy that fails during synth, which CDK reports without a `❌` line, counts as failed too.

The external-database migration step and the dev server's `secret()`/`config()` type generation follow the level as well: migration output is hidden at `quiet` (and printed to stderr if the migration fails), and type-generation notices are hidden at `quiet` and `normal`.

`BLOCKS_LOG_STREAM=stderr` moves progress to stderr: progress steps, CDK milestones, raw CDK output, streamed CloudFormation events, migration output and type-generation notices go to stderr, and stdout keeps only the results (the deployment target, `BLOCKS_DEPLOYED` and the final URLs). `blocks-generate-spec` follows it too: its progress lines go to stderr, and stdout keeps the `✅ OpenRPC spec written to …` line. Without the variable, the streams are unchanged. `@aws-blocks/core/scripts` exports `log`, the logger these scripts print progress with.
