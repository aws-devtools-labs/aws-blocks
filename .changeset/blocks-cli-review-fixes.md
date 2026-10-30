---
"@aws-blocks/blocks": patch
---

fix(blocks): `blocks` output streams, non-interactive runs and usage errors

- `--no-input` and `CI` reach `blocks secret`, `blocks config` and `blocks db pull`: a value prompt that the run cannot show is a usage error (exit 2) naming `--value-stdin`, even on a terminal. A missing key, an unknown subcommand, a missing flag value, an unknown `db` verb (with a suggestion) and an unconfirmed `secret remove --force` also exit 2. The global `--yes` confirms `secret remove --force`, as `--yes` after the command does.
- `--quiet` does not hide the dev server's RPC errors; it sets only `BLOCKS_LOG_LEVEL=quiet`. A `BLOCKS_DEV_QUIET` you set yourself still applies.
- Text output: the CLI runs core with `BLOCKS_LOG_STREAM=stderr`, so progress, CDK milestones, raw CDK output and streamed CloudFormation events go to stderr, and stdout keeps the deployment target, `BLOCKS_DEPLOYED` and the final URLs. `blocks generate spec` follows it too: its progress lines go to stderr, and stdout keeps the `✅ OpenRPC spec written to …` line.
- `blocks deploy` and `blocks sandbox deploy` print no JSON or `--query` result after a failed or interrupted run, and report the account and Region the deploy itself used, read from `.blocks-sandbox/last-deploy.json`, which the deploy writes.
- Arguments after `--` are rejected with exit 2 (`unexpected arguments after --`) for commands that do not forward them, instead of being dropped.
