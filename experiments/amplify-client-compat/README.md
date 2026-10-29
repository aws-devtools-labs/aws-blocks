# Experiment: Amplify client libraries backed by AWS Blocks

Prototype for using the `aws-amplify` client libraries against a backend
**provisioned by AWS Blocks instead of the Amplify Gen 2 toolchain** (`ampx`).

## Idea

Amplify client libs are configured by `amplify_outputs.json`. Today `ampx`
writes that file. This experiment has **Blocks** write it instead — the
write-side analogue of Blocks' native-platform spec exporter
(`generate-spec` → `blocks.spec.json`). An app then calls
`Amplify.configure(outputs)` and runs standard Cognito `signUp`/`signIn`
against a Blocks-provisioned User Pool, with no Amplify backend definition.

## Files

- `src/amplify-outputs-schema.ts` — types for `amplify_outputs.json` v1 (auth/storage/custom subset), faithful to the official `schema_v1.json`.
- `src/emit-amplify-outputs.ts` — **core**: `emitAmplifyOutputs(facts, opts)` maps the values `AuthCognito` exposes at synth → a schema-valid auth section, and returns `gaps[]` for anything the Amplify schema can express but Blocks does not model (e.g. Email MFA, AppSync data, Identity-Pool storage). `validateAmplifyOutputs(o)` checks required-field invariants.
- `src/cdk-shim.ts` — how a real Blocks CDK app reads `auth.userPool` / `auth.userPoolClient` (both `public readonly`) and writes the file.
- `src/amplify-client.ts` — `configureFromBlocks(outputs)` + `doSignUp`/`doSignIn`; the standard Amplify client half, unchanged from a stock app.
- `test/real-amplify-parse.test.ts` — runs the real `aws-amplify@6` `isAmplifyOutputs` / `parseAmplifyOutputs` (what `Amplify.configure()` executes) on the emitted file. Types and runtime both resolve against the real `aws-amplify` package (symlink `node_modules` from the main checkout).
- `test/real-amplify-storage.test.ts` — runs the real `aws-amplify/storage` `getUrl` (local presign, no network) on the emitted storage section: `NoCredentials` as emitted; with a custom `credentialsProvider` it signs against the Blocks bucket and resolves the identity prefix.
- `test/real-amplify-data.test.ts` — wire-contract probe: the real `generateClient()` against a local 127.0.0.1 stub GraphQL server, with `model_introspection` generated offline from `a.schema`. Pins the transport, auth header and operation names a Blocks backend would have to serve.
- `test/real-amplify-signin-flow.test.ts` — the real `aws-amplify@6` Auth client against a local 127.0.0.1 stub Cognito endpoint: records which auth flow `signIn()` requests (Amplify defaults to SRP, which a Blocks app client does not enable).
- `test/emit-amplify-outputs.test.ts` — `node:test` unit tests for the emitter.
- `test/client-types.types-test.ts` — typecheck-only proof that the emitted object binds to `Amplify.configure`/`signUp`/`signIn`.

## Verify (no AWS, no deploy)

Uses a main checkout's `node_modules` (it includes `aws-amplify@6.17.0`), symlinked into the worktree root:

```bash
cd <worktree-root>
ln -sfn <main-checkout>/node_modules node_modules
# Typecheck against the real aws-amplify types (includes the strict AmplifyOutputs assignment):
./node_modules/.bin/tsc --noEmit -p experiments/amplify-client-compat/tsconfig.json
# Unit tests, including the real parseAmplifyOutputs run:
node --import ./node_modules/tsx/dist/loader.mjs --test experiments/amplify-client-compat/test/*.test.ts
```

## Live POCs (deployed to a sandbox account)

Each subdirectory is a Blocks app with its own README covering how to deploy
it, the live test, and the expected result:

- `live-app/` — stock Amplify Auth `signIn` against a Blocks-provisioned user pool.
- `liveness/` — the stock Amplify UI Face Liveness components on a Blocks
  backend, with no Identity Pool and no Cognito tokens in the browser.
- `storage-browser/` — the stock Amplify UI `<StorageBrowser>` and
  `aws-amplify/storage` on a Blocks backend, with credentials vended by the
  Blocks API.
