# Telemetry E2E Test App

Isolated end-to-end tests for the AWS Blocks telemetry system.

## Isolation

This suite runs in a **completely separate environment** from the other e2e
test apps:

- Its own test application (`test-apps/telemetry`, distinct from
  `test-apps/comprehensive`).
- A suite-level `before()` seeds the pinned installation-id in `$HOME/.blocks/`
  so telemetry state is deterministic without affecting other suites.
- Each captured event is written to a unique `--telemetry-file` path (the sink
  creates the file with `O_EXCL`, so paths are never reused).

## Pinned installation ID

Matching the CI setup (the "Seed fixed e2e telemetry installation ID" step in
`.github/workflows/pr-checks.yml`), the suite pins a fixed installation ID
(`00000000-0000-0000-0000-000000000e2e`) by writing
`$HOME/.blocks/telemetry/installation-id` **before** any CLI invocation. This
keeps emitted `installationId` values deterministic and suppresses the
first-run consent notice.

One dedicated test deletes the pinned file, lets the real CLI create a fresh
random ID, and asserts it was created correctly.

## What's tested

- **`--telemetry-file` emission + attributes**: blocks version, template
  name/version, os, ci, per-command name, and building-block counters
  (official BB names + version, custom BB count, total blocks count).
- **Identifier creation**: `installationId` and `projectId` are written when
  they do not already exist, and emitted events carry them.
- **Per-command success + failure**: SUCCESS + FAIL events for `deploy`,
  `destroy`, `sandbox`, `sandbox:destroy`, and `dev`; `console` SUCCESS only;
  `create-blocks-app` and `vendorize` document the no-telemetry limitation for
  their failure paths.
- **Network resilience**: broken endpoint is invisible to users, visible with
  NODE_DEBUG, and does not crash or delay the command.
- **Disable mechanisms**: env var, global config, project config.
- **Schema forward-compatibility**: payload is JSON-serializable with all
  required fields.
- **Environment metadata**: nodeVersion, os, ci fields validated.
- **Consent CLI**: `blocks-telemetry` --help, --disable, --enable, --status,
  --global variants.

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

Tests exercise real CLI commands. The `dev` server starts without AWS and emits
`dev/SUCCESS`. Cloud commands (`sandbox`, `deploy`, `destroy`) require valid AWS
credentials — in CI these are provided by `aws-actions/configure-aws-credentials`.
FAIL paths are exercised by clearing credential env vars so CDK fails fast.

The `--telemetry-file` flag captures the event payload to disk for structure
assertions, while `NODE_DEBUG=blocks-telemetry` stderr output verifies actual
delivery to the telemetry endpoint (`sent (status=200)`).
