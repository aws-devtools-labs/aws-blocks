# cli-test

A test app built to **exercise every `blocks` command meaningfully**. Unlike a
minimal app (e.g. `telemetry`), the backend here declares the inputs each
command acts on, so running a command produces a visible, useful result rather
than a no-op.

What the backend (`aws-blocks/index.ts`) declares, and which command each one
feeds:

| Declaration | Command it makes meaningful |
|---|---|
| `export const api = new ApiNamespace(...)` with `echo` / `cachedCount` / `hasStripeKey` | `generate-client` emits a typed client with those methods |
| `secret('STRIPE_KEY')` and `config('FEATURE_FLAGS', { schema })` | `typegen` generates the key type augmentation (and inlines the schema type) |
| `new RawRoute(... '/health' ...)` | `dev` serves an endpoint; `deploy`/`sandbox` provision it |
| `new KVStore(scope, 'cache')` | `deploy`/`sandbox` create a real table; `dev` emulates it locally |
| `getSecret` / `getConfig` in handlers | the runtime read path for the declared values |

## Setup

From the repo root, build the workspace (which builds the CLI), then run
commands in this directory:

```
npm run build            # at repo root
cd test-apps/cli-test
blocks <command>
```

## Per-command walkthrough

### `blocks dev`
Runs the local dev server. Hit `http://localhost:3000/health` (the `RawRoute`)
and call the API namespace from a client. The `KVStore` is emulated locally, so
`api.cachedCount()` increments across calls with no AWS. **Value:** full local
loop with no deploy.

### `blocks generate-client`
Reads the `ApiNamespace` export and writes a typed browser client exposing
`api.echo(...)`, `api.cachedCount()`, `api.hasStripeKey()`. **Value:** this app
has a real namespace, so the generated client is non-empty (in a namespace-less
app it would be trivial).

### `blocks typegen`
Statically scans the `secret('STRIPE_KEY')` / `config('FEATURE_FLAGS', …)`
calls and writes a `.d.ts` that narrows `getSecret` / `getConfig` to exactly
those keys — autocomplete, typo errors, and (via the Zod schema)
`getConfig('FEATURE_FLAGS')` typed as `{ beta: boolean; maxItems: number }`
instead of `string`. **Value:** this is the command that is a no-op in an app
with no `secret()`/`config()` declarations (e.g. `telemetry`) — here it has real
keys to narrow.

### `blocks config` / `blocks secret`
Manage the config and secret values the backend declares (set / list / remove).
`config set FEATURE_FLAGS '{"beta":true,"maxItems":10}'`, then `blocks dev` and
hit `/health` to see `beta` reflected. **Value:** closes the declare → set →
read loop.

### `blocks deploy` / `blocks sandbox`
Provision the stack (API Gateway + Lambda + the KVStore table) to AWS.
`sandbox` is the per-developer disposable stack; `deploy` is the production
stack. Both use the sandbox CDK posture here so they tear down cleanly.
**Value:** real resources exist to inspect. (Needs AWS credentials.)

### `blocks destroy` / `blocks sandbox:destroy`
Tear down the production / sandbox stack created above.

### `blocks console`
Open the Blocks console for the deployed app.

### `blocks cleanup`
Reclaim a stale/orphaned dev-server port or process (e.g. after a crashed
`blocks dev`). **Value:** try it after Ctrl-C'ing a `dev` that left `:3000`
bound.

### `blocks spec`
Generate / validate the app spec for this backend.

### `blocks vendorize`
Vendor the CLI/scripts into the app (the pre-single-CLI model). **Value:** shows
exactly what the single-CLI proposal replaces.

### `blocks telemetry`
Manage CLI telemetry consent (`status` / `enable` / `disable`) — independent of
app content.

### `blocks help [command]`
Show help for the CLI or one command.

## Note

This app is a manual CLI-exploration fixture, not an automated e2e suite — its
`test` script is a placeholder. The point is to run each command by hand and see
what it does against a backend that gives every command something real to act on.
