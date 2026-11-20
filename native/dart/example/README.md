# Dart SDK Example & E2E Tests

This directory contains the E2E test suite for the Dart native SDK. It runs
against the **`test-apps/native-bindings`** backend, which exercises the blocks
native clients consume (four `Auth` blocks — email + password, a
Cognito-style configuration and two with OIDC through the local stub IdP — plus realtime,
file, KV, and a todo list backed by a KVStore with a `schema` and a `key`).

## Structure

- `bin/e2e/` — Test suites:
  - `kv_store_test.dart` — KV store round-trips
  - `todos_test.dart` — KVStore todos (auth-gated behind the email + password `Auth` block)
  - `file_bucket_test.dart` — presigned upload/download + server-side put/get
  - `realtime_test.dart` — cursor channel publish/subscribe
  - `auth_basic_test.dart` — email + password `Auth` (signUp → emailed code → confirm, which signs the user in → signIn)
  - `auth_cognito_test.dart` — Cognito-style `Auth` (signUp → code → confirm → signIn, groups)
  - `auth_sign_up_attributes_test.dart` — sign-up attributes through the Cognito-style block's `setAuthState` (`SignUpInput.additionalProperties`, sent flat), read back after sign-in; the JSON round trip runs against any backend
  - `oidc_test.dart` — OIDC server-relay against the stub IdP (see below)
  - `rpc_wire_test.dart` — the JSON-RPC wire contract against `api.echoArgs`: params are positional, so a left-out optional keeps its slot as `null` and trailing unset ones are left off
  - `rest_tuple_params_test.dart` — a rest parameter typed as a tuple, against `api.echoRestArgs`: one positional param per element
  - `session_restart_test.dart` — restores sessions across processes and signs out of one Auth block without affecting the other (local only)
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
`http://localhost:3001/cdk-blocks/api`), and executes all tests.

To run against a deployed endpoint:
```bash
native/dart/run-e2e.sh --blocks-url https://xxx.execute-api.us-west-2.amazonaws.com/prod/cdk-blocks/api
```

## Verification codes and deployed backends

Locally the backend reads each sign-up code back (`basicGetLastCode` /
`cognitoGetLastCode`), so the suites run the full sign-up flow. Against a
deployed backend Cognito emails the code, so those legs print `⊘ SKIP` and the
suites sign in a pre-provisioned, confirmed user instead. Seed only a disposable
native-bindings test stack; the command can reset the test account's password.
Set `STACK_NAME` and `REGION` to that stack and region:

```bash
(cd test-apps/native-bindings && BLOCKS_STACK_NAME="$STACK_NAME" AWS_REGION="$REGION" npm run seed:cognito)
```

## OIDC suite

`oidc_test.dart` validates the server-relay sign-in + cookie-persistence flow
headlessly against `Auth`'s stub IdP. It signs in with the `OidcClient` the
backend's `oidcAuthApi.getClient()` returns (`Auth.createOidcApi()`), which carries
the block's `/cdk-blocks/auth/*` routes.

Against a deployed backend the suite runs with `RUN_OIDC=1` (the deployed
sandbox's stub IdP, or a real, auto-approving IdP — `NATIVE_E2E_OIDC_ISSUER` /
`NATIVE_E2E_OIDC_CLIENT_ID`, see `test-apps/native-bindings/README.md`) and
prints `⊘ SKIP` otherwise.

The sandbox stub lets anyone sign in as its test users. Use only disposable test data.
