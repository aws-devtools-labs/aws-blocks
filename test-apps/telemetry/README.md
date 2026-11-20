# Telemetry E2E Test App

Isolated end-to-end tests for the AWS CDK Blocks telemetry system.

## Running

Use a disposable HOME and a dedicated E2E AWS account. The suite overwrites
the telemetry installation ID and removes `$HOME/.cdk-blocks/telemetry` at exit.

```bash
# From monorepo root (requires build first):
npm run build
npm run test:telemetry

# Directly:
cd test-apps/telemetry
npx tsx test/telemetry-e2e.test.ts
```

The `sandbox`, `deploy` and `destroy` cases need AWS credentials from the
environment or from `~/.aws` (see [Concurrent groups](#concurrent-groups)).

## Isolation

Each test uses its own `--telemetry-file`. The reader takes the first element of the array, so a command emitting
more than one event is asserted on its first. Multi-event ordering and length
are covered by the unit suites (`packages/core/src/telemetry/telemetry.test.ts`,
"keeps every event when one run emits several").

## Concurrent groups

The suite runs four groups at the same time; inside each group the cases run
in order:

- **local commands**: these run from this directory with the caller's HOME unless
  a case sets its own. The CDK opt-out case temporarily changes `cdk.context.json`.
- **CLI commands**: `help`, `docs`, `dev stop` and its `cleanup` alias,
  `generate client|spec|types`, `migrate`, `whoami`, `secret`, `config`, `db`,
  `sandbox deploy` and `sandbox preview`, plus the `blocks-generate-client` and
  `blocks-generate-spec` bins run directly (as an app on vendored scripts runs
  them), in their own app copy under `.e2e-groups/cli-commands` and
  their own HOME, with no `~/.aws` link and every AWS credential source blocked,
  so no case reaches an account. Each case runs twice: once to check its event
  is delivered, and once against an unreachable endpoint to check that the exit
  code and the recorded outcome do not change.
- **AWS sandbox lifecycle**: `sandbox:deploy`, `sandbox:destroy` and `console`.
- **AWS production lifecycle**: `deploy` and `destroy`.

API Gateway allows one edge-optimized CreateRestApi, and one DeleteRestApi,
every 30 s per account, and the app's stack has one REST API. So every deploy
that reaches AWS starts at least 60 s after the previous one, and every destroy
60 s after the previous destroy, whichever group runs them. The sandbox group,
the longer one, takes the first deploy slot.

Two rules follow from how the AWS groups run:

- AWS credentials must come from the environment (as in CI) or from `~/.aws`.
  A credential helper that keeps its state elsewhere in HOME won't find it.
- A new top-level entry in this directory fails the run until it is added to
  `APP_ENTRIES` or `APP_EXCLUDED` in the test.

Each AWS group runs its commands in its own copy of the app under
`.e2e-groups/<group>/app` (git-ignored, removed at the end) with its own HOME:

- The copy takes the app entries listed in `APP_ENTRIES`. It keeps the CLI
  state that lives in the project root apart: `cdk.out` (two cdk processes on
  one `cdk.out` collide on its lock), `.cdk-blocks-sandbox/` and the generated
  client.
- Each group's HOME has its own pinned installation ID
  and links to the real `~/.aws`, `~/.npm`, `~/.npmrc` and `~/.cdk.json`
  (whose `profile` and `region` pick the deployment target).

A suite-level `before()` writes one fresh sandbox id to this directory and to
both copies. Sandbox and production stack names differ
(`bb-telemetry-e2e-<id>-...` and `bb-telemetry-e2e-prod-...-<id>`), so the groups
never share a stack, and the destroy scripts run from this directory (the CI
"Cleanup stacks" step) still reach a stack either group left behind.

## Pinned installation ID

Matching the CI setup (the "Seed fixed e2e telemetry installation ID" step in
`.github/workflows/pr-checks.yml`), the suite pins a fixed installation ID
(`00000000-0000-0000-0000-000000000e2e`) by writing
`$HOME/.cdk-blocks/telemetry/installation-id` **before** any CLI invocation. This
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
- **Every CLI command**: one event per invocation, named after the command
  path (`dev:stop`, `generate:client`, `sandbox:deploy`, ...), with SUCCESS
  where the command needs no AWS and FAIL (usage error or no credentials)
  otherwise.
- **Per-command success + failure**: SUCCESS + FAIL events for `deploy`,
  `destroy`, `sandbox:deploy`, `sandbox:destroy`, and `dev`; `console` SUCCESS only;
  `create-blocks-app` and `vendorize` document the no-telemetry limitation for
  their failure paths. The cloud failure cases clear the three AWS session
  environment variables, but can still find credentials through other providers.
- **Network resilience**: broken endpoint is invisible to users, visible with
  NODE_DEBUG, and does not crash or delay the command.
- **Schema forward-compatibility**: payload is JSON-serializable with all
  required fields.
- **Environment metadata**: nodeVersion, os, ci fields validated.
- **CDK opt-out**: `CDK_DISABLE_CLI_TELEMETRY=1` or `true` disables telemetry, as does
  `cli-telemetry: false` in the app's `cdk.context.json`. Setting the environment variable to `0` leaves telemetry on.

## Design

Tests exercise real CLI commands.

The `--telemetry-file` flag captures the event payload to disk for structure
assertions, while `NODE_DEBUG=blocks-telemetry` stderr output verifies actual
delivery to the telemetry endpoint (`sent (status=200)`).
