# Dart SDK Example & E2E Tests

This directory contains the E2E test suite for the Dart native SDK. It runs
against the **`test-apps/native-bindings`** backend, which exercises the blocks
native clients consume (auth basic + cognito, OIDC, realtime, file, KV, and a
todo list backed by a KVStore with a `schema` and a `key`).

## Structure

- `bin/e2e/` — Test suites:
  - `kv_store_test.dart` — KV store round-trips
  - `todos_test.dart` — KVStore todos (auth-gated behind AuthBasic)
  - `file_bucket_test.dart` — presigned upload/download + server-side put/get
  - `realtime_test.dart` — cursor channel publish/subscribe
  - `auth_basic_test.dart` — AuthBasic (signUp → signIn, no confirm step)
  - `auth_cognito_test.dart` — AuthCognito (signUp → code → confirm → signIn)
  - `oidc_test.dart` — OIDC server-relay (gated; see below)
- `bin/e2e_test.dart` — Test runner (executes all suites sequentially)
- `lib/blocks_client.dart` — Generated client (produced fresh by `run-e2e.sh`,
  not checked in as source of truth)

## Running

From the monorepo root:
```bash
native/dart/run-e2e.sh
```

This generates the spec from `test-apps/native-bindings`, runs codegen, starts
the local dev server (`npm run dev:server`, JSON-RPC at
`http://localhost:3001/aws-blocks/api`), and executes all tests.

To run against a deployed endpoint:
```bash
native/dart/run-e2e.sh --blocks-url https://xxx.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api
```

## OIDC suite (opt-in)

`oidc_test.dart` validates the server-relay sign-in + cookie-persistence flow
headlessly. It is gated behind `RUN_OIDC=1` and **excluded from the default
local run** because the local dev server is plain http and the stub IdP rejects
non-HTTPS redirect_uris.

It is meant to run in the **`dart-e2e-sandbox` CI job**, which deploys an HTTPS
native-bindings sandbox on the spot (deploy → test → destroy) — that job sets
`RUN_OIDC=1` so the relay suite runs automatically against the fresh sandbox.

Two prerequisites before that job goes green:
1. The server-relay `OidcClient` (`signInRelay` / `PersistentSessionStore`)
   from PR #824 (`feat/dart-oidc-server-relay`) must be on the branch —
   otherwise `oidc_test.dart` does not compile.
2. `test-apps/native-bindings` needs its CDK deploy entrypoint
   (`aws-blocks/index.cdk.ts`); `npm run deploy` references it but only
   `cdk.json` is currently committed.

To run it locally against an already-deployed sandbox:
```bash
RUN_OIDC=1 BLOCKS_URL=https://xxx.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api \
  dart run bin/e2e_test.dart
```
