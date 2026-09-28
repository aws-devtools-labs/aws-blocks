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
- `test/emit-amplify-outputs.test.ts` — `node:test` unit tests (8).
- `test/client-types.types-test.ts` — typecheck-only proof that the emitted object binds to `Amplify.configure`/`signUp`/`signIn`.

## Verify (no AWS, no deploy)

Uses the main checkout's `node_modules` (it includes `aws-amplify@6.17.0`), symlinked into the worktree root:

```bash
cd <worktree-root>
ln -sfn /home/rhamouda/workspace/aws-blocks/node_modules node_modules
# Typecheck against the real aws-amplify types (includes the strict AmplifyOutputs assignment):
./node_modules/.bin/tsc --noEmit -p experiments/amplify-client-compat/tsconfig.json
# Unit tests, including the real parseAmplifyOutputs run:
node --import ./node_modules/tsx/dist/loader.mjs --test experiments/amplify-client-compat/test/*.test.ts
```

Both pass (tsc exit 0; 10/10 tests). See `../../amplify-blocks-experiment.md` (in the workspace) for the
findings, feature-gap table, and one-way-door decisions.

## NOT done

No deploy to any AWS account (no `cdk synth`/`deploy`, no credentials). The
end-to-end proof — deploy a Blocks stack, read back real pool IDs, run a live
browser `signIn` — is the next milestone and requires an account.
