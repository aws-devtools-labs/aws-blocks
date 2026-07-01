# Telemetry E2E Test App

Isolated end-to-end tests for the AWS Blocks telemetry system.

## Isolation

This suite runs in a **completely separate environment** from the other e2e
test apps:

- Its own test application (`test-apps/telemetry`, distinct from
  `test-apps/comprehensive`).
- Every test overrides `HOME` to a throwaway temp directory, so the telemetry
  installation-id, global config, and any consent state live in a sandboxed
  home and never touch the developer's real `~/.blocks` or another suite's
  state.
- Each captured event is written to a unique `--telemetry-file` path (the sink
  creates the file with `O_EXCL`, so paths are never reused).

## Pinned installation ID

Matching the CI setup (`.github/actions/seed-telemetry-id`), the suite pins a
fixed installation ID (`00000000-0000-0000-0000-000000000e2e`) by writing
`$HOME/.blocks/telemetry/installation-id` **before** any CLI invocation. This
keeps emitted `installationId` values deterministic and suppresses the
first-run consent notice.

One dedicated test deletes the pinned file, lets the real CLI create a fresh
random ID, asserts it was created correctly, and then **restores** the pinned
value in teardown.

## What's tested

- **`--telemetry-file` emission + attributes**: blocks version, template
  name/version, os, ci, per-command name, and building-block counters
  (official BB names + version, custom BB count, total blocks count).
- **Identifier creation**: `installationId` and `projectId` are written when
  they do not already exist, and emitted events carry them.
- **Per-command success + failure**: every telemetry-emitting command
  (`deploy`, `destroy`, `sandbox`, `sandbox:destroy`, `cleanup`, `console`,
  `create-blocks-app`, `dev`) emits a correct SUCCESS event and a correct FAIL
  event (with error code/phase).
- **Pinned ID recreation**: delete → recreate → restore lifecycle.

## Running

```bash
# From monorepo root (requires build first):
npm run build
npm run test:telemetry

# Directly:
cd test-apps/telemetry
npx tsx test/telemetry-e2e.test.ts
```

## Design

Tests run **without AWS credentials**. Cloud commands (`sandbox`, `deploy`,
`destroy`) fail fast during CDK synth/deploy but still fire their telemetry
event with `state: FAIL` — that failure event is what those integration tests
assert. The SUCCESS terminal state for every command is exercised through the
real `trackCommand` pipeline via `aws-blocks/scripts/emit.ts`, which wraps a
controlled operation with the exact same telemetry code the production commands
use. The `dev` server needs no AWS and starts successfully.
