# AWS CDK Blocks Dart

The Dart SDK for AWS CDK Blocks.

AWS CDK Blocks lets you define a backend in TypeScript (APIs, auth, databases, realtime channels, file storage) and deploy it to AWS. This SDK gives your Flutter app a typed client that talks to that backend with zero boilerplate.

## How it works

You write your backend. AWS CDK Blocks generates a spec file describing your API. This SDK reads that spec and produces a Dart client with typed methods, models, and realtime subscriptions, ready to drop into your Flutter app.

```
Your backend (TypeScript)  →  blocks.spec.json  →  blocks_codegen  →  Typed Dart client
```

## What you get

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com/cdk-blocks/api');

// Call your API methods with full type safety
final todo = await blocks.api.createTodo(title: 'Buy milk', priority: 1);
final todos = await blocks.api.listTodos(sortBy: SortBy.priority);

// Auth flows with exhaustive variants
await blocks.authApi.setAuthState(
  input: SignInInput(username: 'alice', password: 'secret'),
);

// Realtime: subscribe to live data over WebSocket
final channel = await blocks.api.getCursorChannel();
channel.subscribe().listen((cursor) {
  print('${cursor.userId} moved to (${cursor.x}, ${cursor.y})');
});

// Done with the backend: free the HTTP client. Later calls throw
// ClientClosedException.
blocks.close();
```

## Packages

| Package | Role |
|---------|------|
| **blocks_runtime** | The runtime your app ships with: HTTP client, WebSocket realtime, file handles, OIDC client |
| **blocks_codegen** | The code generator: reads your spec, outputs Dart. Only runs at build time. |
| **blocks_runtime_flutter** | Flutter support: keeps the session in the platform's secure storage, and opens the browser for OIDC sign-in |

[The Dart example](example/README.md) holds the end-to-end tests the SDK runs against `test-apps/native-bindings`.

## Quick Start

You need Node.js 22 or later for the backend, and Flutter 3.41 or later (Dart 3.11 or later) for the app.

### 1. Create a backend

Create a backend with the `api-only` template, which has no web frontend:

```bash
npm create @aws-cdk-blocks/blocks-app@latest my-backend -- --template api-only
cd my-backend
npm run dev
```

`npm run dev` starts a local development server for the API at `http://localhost:3001/cdk-blocks/api`. Leave it running.

### 2. Generate the spec

In a second terminal, in `my-backend`:

```bash
npm run spec
```

This writes `cdk-blocks/blocks.spec.json`, which describes every method the backend exports. It also records the URL of the dev server that last ran, so the generated client calls it by default. Run `npm run spec` again after you change the backend. To point the client at AWS instead, deploy a sandbox with `npm run sandbox:deploy` and then run `BLOCKS_SPEC_STAGE=sandbox npm run spec`; the spec then names the deployed API URL, stage segment included. `npm run sandbox:destroy` deletes the sandbox.

### 3. Add the packages to your app

Create the app and add the packages:

```bash
flutter create my_app
cd my_app
```

```yaml
# pubspec.yaml
dependencies:
  blocks_runtime: ^1.0.0
  blocks_runtime_flutter: ^1.0.0

dev_dependencies:
  blocks_codegen: ^1.0.0
  build_runner: ^2.14.0
```

`blocks_runtime_flutter` keeps the session in the platform's secure storage (see [Sessions](#sessions)). A pure Dart program needs only `blocks_runtime`.

### 4. Generate the client

Copy the spec into `lib/` and run the builder:

```bash
cp ../my-backend/cdk-blocks/blocks.spec.json lib/
dart run build_runner build
```

The builder turns every `*.spec.json` file in the package into a `*.blocks.dart` file next to it, here `lib/blocks.blocks.dart`. It needs no `build.yaml`; add one only to set the builder's options (see [blocks_codegen](packages/blocks_codegen/README.md#options)). Copy the spec and run the builder again whenever the backend changes.

### 5. Use it

The `api-only` template exposes a public `health` RPC:

```dart
import 'blocks.blocks.dart';

Future<void> main() async {
  // With no baseUrl, the client calls the server the spec names. Pass
  // baseUrl: 'https://<your API>/cdk-blocks/api' to call another one.
  final blocks = Blocks();
  final health = await blocks.api.health();
  print(health.status.toJson()); // ok
}
```

`api` is the backend's `export const api = new ApiNamespace(...)`: each export becomes a field of the generated `Blocks` class, and each method a Dart method with named parameters.

Before you run the app:

- **macOS:** a Flutter macOS app runs in the App Sandbox, which blocks outgoing connections until you add the `com.apple.security.network.client` entitlement to `macos/Runner/DebugProfile.entitlements` and `macos/Runner/Release.entitlements`. Without it every call throws a `TransportException`.

  ```xml
  <key>com.apple.security.network.client</key>
  <true/>
  ```

- **Android emulator:** keep `localhost:3001` and run `adb reverse tcp:3001 tcp:3001`. See [Configuration](#configuration) for when a host rewrite works instead.

## Using Auth

Use an `Auth` block's `createApi()` state machine for password sign-in, sign-up and challenges. Call `getAuthState()` on launch and after a federated sign-in or sign-out.

- For federated sign-in, keep the `OidcClient` returned by `createOidcApi()`'s `getClient()`. Render its `providers`, not the state machine's `signIn:<id>` actions: those URLs start a browser session whose cookie never reaches the app.
- When a `signOut` action carries a URL, call `oidc.signOut()` rather than `setAuthState`. Open the returned logout URL, if present, to end the identity provider's session too.

See [Using Auth in `blocks_runtime`](packages/blocks_runtime/README.md#using-auth) for the Flutter sample, retriable errors, restoring sessions and handling passkeys.

### Federated sign-in on each platform

See the [platform setup and cancellation rules](packages/blocks_runtime/README.md#federated-sign-in-on-each-platform) in the runtime README.

## Configuration

The generated `Blocks` class takes two parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseUrl` | `String?` (`String` when the spec declares no server) | The spec's first server. Required when the spec declares no server. | The JSON-RPC endpoint, for example `http://localhost:3001/cdk-blocks/api`. |
| `sessionStore` | `SessionStore?` | Platform default | Where session cookies are kept (see Sessions below). |

To set the HTTP client, token store or bearer auth provider, pass a custom [`BlocksClient`](packages/blocks_runtime/README.md#blocksclient) to each generated API class instead.

On an Android emulator `localhost` is the emulator itself:

- Keep `localhost` and forward the port into the emulator: `adb reverse tcp:3001 tcp:3001`.
- `BlocksConfig.rewriteLocalhost(url, host: '10.0.2.2')` also reaches the host machine, but not for federated sign-in: the identity provider's redirect URI is built from the base URL, and Google accepts an `http` redirect URI only on `localhost` and `127.0.0.1`.

## Sessions

- **Flutter on mobile and desktop:** add `blocks_runtime_flutter` and clients share a secure session store automatically. See [platform setup](packages/blocks_runtime_flutter/README.md#platform-setup) for macOS entitlements, Android backup rules and Linux dependencies.
- **Web:** the browser manages cookies for a backend on the app's own origin.
- **Pure Dart:** sessions are in memory per client unless you register a store at startup. See [Sessions](packages/blocks_runtime/README.md#sessions) for `FileTokenStore`, lazy loading, storage errors and flushing before exit.

| Where the app runs | Where the session is kept |
|---|---|
| Flutter on Android, iOS, macOS, Linux or Windows, with `blocks_runtime_flutter` | The platform's secure storage, through `flutter_secure_storage` (the Keystore on Android, the Keychain on iOS and macOS). The user stays signed in after the app restarts. |
| Flutter web, or Dart compiled for the web | The browser's own cookie jar, for a backend on the app's own origin. The browser never shows the session cookie to Dart. |
| A pure Dart program (command-line tool, server) | Memory, unless the program registers a store (see below). |

A Flutter app needs no code for this. Add the dependency:

```yaml
dependencies:
  blocks_runtime: ^1.0.0
  blocks_runtime_flutter: ^1.0.0
```

and build the client as usual, before or after `runApp`. The app does not have to call `WidgetsFlutterBinding.ensureInitialized()` first:

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com/cdk-blocks/api');
// Signed in if the user was signed in before the app restarted.
final state = await blocks.authApi.getAuthState();
```

`blocks_runtime_flutter` registers itself as a Dart plugin, so Flutter sets up the secure store before `main` runs. Every `Blocks` (and `BlocksClient` or `OidcClient`) built without a `sessionStore:` then shares that one store. It reads the saved session before the first call, and writes it back only when the backend changes a cookie. If the secure storage cannot be read or written, the call still goes ahead with the session held in memory, and the error is passed to `FlutterError.reportError` as a silent error, so a crash reporter hooked to `FlutterError.onError` sees it.

macOS, Android and Linux each need some app setup for the secure storage to work, or to keep the session safe: the macOS `keychain-access-groups` entitlement, Android backup rules, and the libsecret runtime on Linux. See [Platform setup](packages/blocks_runtime_flutter/README.md#platform-setup).

Flutter does not run plugin registration under `flutter test`, so widget and unit tests keep the session in memory. An `integration_test` run on a device does register it, and keeps the session between runs.

To keep the session in memory only, so that it ends when the process does, pass `InMemorySessionStore()`:

```dart
final blocks = Blocks(
  baseUrl: 'https://your-api.example.com/cdk-blocks/api',
  sessionStore: InMemorySessionStore(),
);
```

A pure Dart program has no per-application storage to default to: the home directory is shared by every program the user runs. To keep its session across runs, it names itself once at startup, before building any client (registering a different store after a client exists throws a `StateError`):

```dart
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'blocks.blocks.dart'; // the generated client

Future<void> main() async {
  final session = PersistentSessionStore(
    store: FileTokenStore(applicationId: 'com.example.notes_cli'),
    onPersistError: (error, _) => stderr.writeln('session not saved: $error'),
  );
  registerDefaultSessionStore(() => session);
  final blocks = Blocks(baseUrl: 'https://your-api.example.com/cdk-blocks/api');
  // ... sign in ...

  // The session is written in the background; wait for it before exit().
  await session.flush();
  exit(0);
}
```

`FileTokenStore` keeps the session unencrypted in `~/.blocks/<applicationId>/dart/`, in a directory only your OS user can read on Linux and macOS. See its documentation for what that does and does not protect against. Without `onPersistError`, a storage error is written once to standard error.

## Features

**Type-safe API calls**: every method, parameter, and return type is generated from your spec. Typos and type mismatches are caught at compile time.

**Realtime subscriptions**: if your backend has realtime channels (e.g., cursor tracking, live updates), the generated client gives you typed `Stream<T>` subscriptions over WebSocket.

A subscription's stream closes normally only when you cancel it or call `close()`. Any other end, such as the channel token expiring after about an hour or the socket closing, emits a `RealtimeException` and then closes the stream. The SDK doesn't reconnect or renew by itself: call the API method that returned the channel again and subscribe to the new handle.

**Auth flows**: each auth action's input is its own class in a sealed union, so a misspelled field or action doesn't compile. `AuthState.state` is a sealed type whose known values are constants (`AuthStateState.signedIn`), and its actions arrive at runtime, so render them by name and skip the ones you don't know. A value a newer backend adds decodes to `AuthStateStateUnknown`, whose `value` is the string as sent, so an exhaustive `switch` needs a case for it.

**File transfers**: presigned upload/download URLs are wrapped in handle objects with simple `.upload(bytes)` / `.download()` methods.

**Typed OIDC providers**: for a custom block whose method returns an OIDC client, when the spec names its providers, the method returns a `TypedOidcClient` of an enum generated for it, so `signIn` accepts only those providers and a typo doesn't compile. See [Typed OIDC providers](packages/blocks_runtime/README.md#typed-oidc-providers) for the type and [Generated names](packages/blocks_codegen/README.md#generated-names) for the enum's name.

**Unbound transferables**: a direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of untyped `dynamic`. Only bare direct results are covered.

**Declared native packages**: when `x-blocks-native-bindings` binds the tag and its package has a `dart` field, the client imports the declared library and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

**No Flutter dependency** — `blocks_runtime` is pure Dart. Works in CLI apps, server-side Dart, or Flutter.

## Errors

Handle SDK failures by `BlocksException` subtype:

| Type | When | Fields |
|---|---|---|
| `ApiException` | The server considered the request and said no: a JSON-RPC error at any HTTP status, or an auth route refusing a request | `message` (the server's), `status`, `name`, `retriable` |
| `TransportException` | No usable JSON-RPC result came back: no response (refused connection, DNS, TLS, timeout), a non-2xx with no JSON-RPC error, or a body that is not a JSON-RPC envelope | `message`, `statusCode` (null when no response arrived), `cause` |
| `ClientClosedException` | A call after `Blocks.close()` (or `BlocksClient.close()`), including a call of an `OidcClient` one of its calls returned | `message` |
| `TransferableException` | A `__blocks` descriptor could not be hydrated; `InvalidDescriptorException` names the `blocksType` and `missingField` | `message` |
| `FileTransferException` | A file upload or download failed | `message`, `statusCode`, `cause` |
| `RealtimeException` (sealed) | `RealtimeChannelClosedException` on a subscribe after close, `RealtimeConnectionException` when the WebSocket fails or closes, `RealtimeSubscriptionEndedException` when the server ends or refuses one channel's subscription (`code` is `token_expired`, `access_revoked`, `principal_mismatch` or null) | `message`, `cause`; `channel` and `code` on `RealtimeSubscriptionEndedException` |
| `OidcException` (sealed) | The OIDC sign-in flow itself failed (callback, cancelled, unknown provider, exchange) | `message`, `cause` |

- Match a server error by name with `isBlocksError(e, 'ConditionalCheckFailedException')`, as on the server and in the TypeScript client.
- Don't branch on `status == 500`: a named error thrown without a status arrives as a 500 with its name intact.
- JSON-RPC's reserved codes are reported as 500, and when the server sends no name for one, the client fills in its name (`ParseError`, `InvalidRequest`, `MethodNotFound`, `InvalidParams` or `InternalError`).
- A gateway rejection such as HTTP 403 with `{"message":"Forbidden"}`, or a response containing HTML, throws `TransportException` even for a void or nullable method. Only a successful JSON-RPC envelope with no error can omit `result` for a void method or return null for a nullable result.
- An envelope with no `result` for a method whose result is not nullable throws a `TypeError` from the generated cast (including channel, file handle and OIDC client results), or a `TransferableException` when the result is an unbound or declared native transferable.
- Outside this taxonomy, an `OidcClient` throws a `StateError`, an `ArgumentError`, a `FormatException` or a `TypeError` in the cases listed under [`OidcClient`](packages/blocks_runtime/README.md#oidcclient) in the `blocks_runtime` README.

### HTTP status

- A JSON-RPC error is an `ApiException` regardless of the HTTP status. A 401 encoded in an HTTP 200 response is not retried.
- On an HTTP 401, a `BlocksClient` with an `authProvider` awaits `onAuthFailure()` and, if that succeeds, retries once. Without a provider there is no retry. Generated `Blocks` does not set one; see [`BlocksClient`](packages/blocks_runtime/README.md#blocksclient) for custom configuration.
- On the backend, check authorization before side effects. If a method can still return HTTP 401 after a write, make it idempotent before using this retry behavior.

## Project structure

```
native/dart/
├── packages/
│   ├── blocks_runtime/          # Runtime library (ships with your app)
│   ├── blocks_codegen/          # Code generator (build-time only)
│   └── blocks_runtime_flutter/  # Flutter integration (secure storage, browser launcher)
├── example/                     # End-to-end tests the SDK runs against a local backend
└── README.md
```

## Requirements

- Dart 3.11+
- Flutter 3.41+, for `blocks_runtime_flutter` (`blocks_runtime` and `blocks_codegen` are pure Dart)
- Node.js 22+, for running the AWS CDK Blocks backend locally

## How the codegen works

The generator has three stages:

1. **Parse**: reads the OpenRPC JSON spec, extracts methods, schemas, and type relationships
2. **Build**: resolves types, deduplicates identical shapes, groups methods into namespaces
3. **Generate**: outputs Dart source with data classes, sealed hierarchies, API methods, and a `Blocks` facade

The output is a single `.blocks.dart` file that imports `blocks_runtime` and re-exports the runtime types an app uses most, such as `ApiException`, `isBlocksError` and `OidcClient`, so most code needs only that one import.

## License

Apache-2.0
