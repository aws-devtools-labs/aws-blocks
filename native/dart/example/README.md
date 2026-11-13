# Dart SDK Example & E2E Tests

This directory contains a sample app, [`bin/auth_cold_start.dart`](#sample-app-signed-in-across-launches),
and the E2E test suite for the Dart native SDK. Both run
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
- `bin/auth_cold_start.dart`: sample app that stays signed in across launches (see below)
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

## Sample app: signed in across launches

`bin/auth_cold_start.dart` is a command-line app for the email + password
`Auth` block (`authBasicApi`). Each run is a fresh launch: it loads the saved
session, calls `getAuthState()`, prints the state and the actions it offers,
and then runs at most one action through `setAuthState`.

Two things make the session survive a restart, and an app needs both:

- **A persistent session store.** `Blocks(baseUrl: ...)` keeps cookies in
  memory, so without one every launch starts signed out. The app passes a
  `PersistentSessionStore` and calls `await session.load()` before the first
  request. Its `TokenStore` is a small JSON file store defined in the app;
  in a Flutter app use `FlutterSecureStore` from `blocks_runtime_flutter`
  instead, since the file holds the session cookie in plain text.
- **`getAuthState()` on launch.** The server checks the saved cookie and
  answers `signedIn` with the user, or `signedOut`. The client keeps no auth
  state of its own between launches.

```dart
final session = PersistentSessionStore(store: JsonFileTokenStore(path));
await session.load();
final blocks = Blocks(baseUrl: url, sessionStore: session);
final state = await blocks.authBasicApi.getAuthState();
```

### Running it

From the monorepo root, after `npm install` and `npm run build`:

```bash
# 1. Start the backend on a free port (it prints sign-up codes to the console).
(cd test-apps/native-bindings && PORT=3001 npx tsx aws-blocks/scripts/server.ts)

# 2. In another terminal: generate the spec and the client.
(cd test-apps/native-bindings && npm run spec)
cd native/dart/packages/blocks_codegen
printf 'dependency_overrides:\n  blocks_runtime:\n    path: ../blocks_runtime\n' > pubspec_overrides.yaml
dart pub get
dart run bin/blocks_codegen.dart \
  --spec ../../../../test-apps/native-bindings/aws-blocks/blocks.spec.json \
  --output ../../example/lib/blocks_client.dart
cd ../../example
printf 'dependency_overrides:\n  blocks_runtime:\n    path: ../packages/blocks_runtime\n  blocks_codegen:\n    path: ../packages/blocks_codegen\n' > pubspec_overrides.yaml
dart pub get

# 3. Each command is a new launch.
export BLOCKS_URL=http://localhost:3001/aws-blocks/api
dart run bin/auth_cold_start.dart                                 # signedOut
dart run bin/auth_cold_start.dart sign-up alice 'Passw0rd!' alice@example.com
dart run bin/auth_cold_start.dart confirm alice <code from the server console>
dart run bin/auth_cold_start.dart                                 # signedIn as alice
dart run bin/auth_cold_start.dart sign-out
dart run bin/auth_cold_start.dart sign-in alice 'Passw0rd!'
```

The `pubspec_overrides.yaml` files point both packages at the in-repo
runtime, as `run-e2e.sh` and CI do. The session is saved in
`.dart_tool/auth_cold_start_session.json`; set `BLOCKS_SESSION_FILE` to use
another file, or delete it to start over.

Confirming the code doesn't sign the user in by itself: the state it returns
offers `autoSignIn`, which the app submits next. A wrong password comes back
as a `signedOut` state with an `error`; a wrong code comes back `retriable`,
and the user stays where they were.

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

The stub IdP runs only locally and on sandbox deployments. The native-bindings
test app always deploys as a sandbox, so its deployed backend serves the stub
too (a sandbox stub signs anyone in as its users).
Against a deployed backend the suite runs with `RUN_OIDC=1` (that deployed stub,
or a real, auto-approving IdP — `NATIVE_E2E_OIDC_ISSUER` /
`NATIVE_E2E_OIDC_CLIENT_ID`, see `test-apps/native-bindings/README.md`) and
prints `⊘ SKIP` otherwise.
