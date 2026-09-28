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
- `src/aws-amplify-shim.d.ts` — local stand-in for `aws-amplify@6`'s surface so the prototype type-checks without installing the dep. Delete when promoted into a real test-app.
- `test/emit-amplify-outputs.test.ts` — `node:test` unit tests (8).
- `test/client-types.types-test.ts` — typecheck-only proof that the emitted object binds to `Amplify.configure`/`signUp`/`signIn`.

## Verify (no AWS, no deploy)

Uses the main checkout's toolchain (worktree has no `node_modules`):

```bash
BIN=/home/rhamouda/workspace/aws-blocks/node_modules
# Typecheck (includes the client-types type-level test):
"$BIN/.bin/tsc" --noEmit --typeRoots "$BIN/@types" -p tsconfig.json
# Unit tests:
node --import "$BIN/tsx/dist/loader.mjs" --test test/emit-amplify-outputs.test.ts
```

Both pass. See `../../amplify-blocks-experiment.md` (in the workspace) for the
findings, feature-gap table, and one-way-door decisions.

## NOT done

No deploy to any AWS account (no `cdk synth`/`deploy`, no credentials). The
end-to-end proof — deploy a Blocks stack, read back real pool IDs, run a live
browser `signIn` — is the next milestone and requires an account.
