# Telemetry E2E Test App

Isolated end-to-end tests for the AWS Blocks telemetry system.

## Isolation

This suite runs in a **completely separate environment** from the other e2e
test apps:

- Its own test application (`test-apps/telemetry`, distinct from
  `test-apps/comprehensive`).
- A suite-level `before()` seeds the pinned installation-id in `$HOME/.blocks/`
  so telemetry state is deterministic without affecting other suites.
- Each captured event is written to a unique `--telemetry-file` path, so no test
  depends on another's file. The reader takes the first element of the array, so a
  command emitting more than one event is asserted on its first. Multi-event
  ordering and length are covered by the unit suites (`packages/core/src/telemetry/
  telemetry.test.ts`, "keeps every event when one run emits several").

## Concurrent groups

The suite runs three groups at the same time; inside each group the cases run
in order:

- **local commands**: every case that needs no AWS account, from this
  directory with the real HOME (unless a case sets its own). They run in order
  because several write the project config (`.blocks/config.json`) or the real
  HOME's global config.
- **AWS sandbox lifecycle**: `sandbox`, `sandbox:destroy` and `console`.
- **AWS production lifecycle**: `deploy` and `destroy`.

API Gateway allows one edge-optimized CreateRestApi, and one DeleteRestApi,
every 30 s per account, and the app's stack has one REST API. So every deploy
that reaches AWS starts at least 60 s after the previous one, and every destroy
60 s after the previous destroy, whichever group runs them. The sandbox group,
the longer one, takes the first deploy slot.

Each AWS group runs its commands in its own copy of the app under
`.e2e-groups/<group>/app` (git-ignored, removed at the end) with its own HOME.
The copy keeps the CLI state that lives in the project root apart: `cdk.out`
(two cdk processes on one `cdk.out` collide on its lock), `.blocks-sandbox/`
and the generated client. The HOME keeps the local group's global-config
cases from disabling telemetry for a cloud command; it is seeded with the
pinned installation-id and links to the real `~/.aws`, `~/.npm`, `~/.npmrc`
and `~/.cdk.json` (whose `profile` and `region` pick the deployment target).
AWS credentials must therefore come from the environment (as in CI) or from
`~/.aws`; a credential helper that keeps its state elsewhere in HOME won't
find it. The copy takes the app entries listed in the test's `APP_ENTRIES`;
a new top-level entry in this directory fails the run until it is added
there or to `APP_EXCLUDED`.

A suite-level `before()` writes one fresh sandbox id to this directory and to
both copies. Sandbox and production stack names differ
(`bb-telemetry-e2e-<id>-...` and `bb-telemetry-e2e-prod-...-<id>`), so the groups
never share a stack, and the destroy scripts run from this directory (the CI
"Cleanup stacks" step) still reach a stack either group left behind.

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
