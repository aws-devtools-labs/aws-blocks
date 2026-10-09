# Dart SDK Example & E2E Tests

This directory contains the E2E test suite for the Dart native SDK. It runs
against the **`test-apps/native-bindings`** backend, which exercises the blocks
native clients consume (three `Auth` blocks — email + password, a
Cognito-style configuration and OIDC through the local stub IdP — plus realtime,
file, KV, and a DistributedTable-backed todo list).

## Structure

- `bin/e2e/` — Test suites:
  - `kv_store_test.dart` — KV store round-trips
  - `todos_test.dart` — DistributedTable todos (auth-gated behind the email + password `Auth` block)
  - `file_bucket_test.dart` — presigned upload/download + server-side put/get
  - `realtime_test.dart` — cursor channel publish/subscribe
  - `auth_basic_test.dart` — email + password `Auth` (signUp → emailed code → confirm, which signs the user in → signIn)
  - `auth_cognito_test.dart` — Cognito-style `Auth` (signUp → code → confirm → signIn, groups)
  - `auth_sign_up_attributes_test.dart` — sign-up attributes through the Cognito-style block's `setAuthState` (`SignUpInput.additionalProperties`, sent flat), read back after sign-in; the JSON round trip runs against any backend
  - `oidc_test.dart` — OIDC server-relay against the stub IdP (local only; see below)
  - `rpc_wire_test.dart` — the JSON-RPC wire contract against `api.echoArgs`: params are positional, so a left-out optional keeps its slot as `null` and trailing unset ones are left off
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

## Verification codes and deployed backends

Every `Auth` sign-up confirms the email address with a code. Locally, the
backend reads the code back (`basicGetLastCode` / `cognitoGetLastCode`), so the
suites run the full sign-up flow. Against a deployed backend Cognito emails the
code, so those legs print `⊘ SKIP` and the suites sign in a pre-provisioned,
confirmed user instead. Seed it into the stack's user pools first:

```bash
(cd test-apps/native-bindings && BLOCKS_STACK_NAME=<stack> AWS_REGION=<region> npm run seed:cognito)
```

## OIDC suite

`oidc_test.dart` validates the server-relay sign-in + cookie-persistence flow
headlessly against `Auth`'s stub IdP. It builds the `OidcClient` from the auth
block's fixed `/aws-blocks/auth/*` routes, with no server-supplied descriptor.

The stub IdP is local-only by default. The native-bindings test app opts in with
`stubIdp({ unsafeAllowDeployed: true })`, so its deployed backend serves the stub
too — never do that in a real app: a deployed stub signs anyone in as its users.
Against a deployed backend the suite runs with `RUN_OIDC=1` (that deployed stub,
or a real, auto-approving IdP — `NATIVE_E2E_OIDC_ISSUER` /
`NATIVE_E2E_OIDC_CLIENT_ID`, see `test-apps/native-bindings/README.md`) and
prints `⊘ SKIP` otherwise.
