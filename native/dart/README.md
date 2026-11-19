# AWS Blocks Dart

The Dart SDK for AWS Blocks.

AWS Blocks lets you define a backend in TypeScript — APIs, auth, databases, realtime channels, file storage — and deploy it to AWS. This SDK gives your Flutter app a typed client that talks to that backend with zero boilerplate.

## How it works

You write your backend. AWS Blocks generates a spec file describing your API. This SDK reads that spec and produces a Dart client with typed methods, models, and realtime subscriptions — ready to drop into your Flutter app.

```
Your backend (TypeScript)  →  blocks.spec.json  →  blocks_codegen  →  Typed Dart client
```

## What you get

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com');

// Call your API methods with full type safety
final todo = await blocks.api.createTodo(title: 'Buy milk', priority: 1);
final todos = await blocks.api.listTodos(sortBy: SortBy.priority);

// Auth flows with exhaustive variants
await blocks.authApi.setAuthState(
  input: SignInInput(username: 'alice', password: 'secret'),
);

// Realtime — subscribe to live data over WebSocket
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
| **blocks_runtime** | The runtime your app ships with — HTTP client, WebSocket realtime, file handles |
| **blocks_codegen** | The code generator — reads your spec, outputs Dart. Only runs at build time. |

## Getting started

### 1. Add dependencies

```yaml
# pubspec.yaml
dependencies:
  blocks_runtime: ^0.2.0

dev_dependencies:
  blocks_codegen: ^0.2.0
  build_runner: ^2.4.0
```

### 2. Add your spec and configure the builder

Drop your `blocks.spec.json` into `lib/`, then create a `build.yaml`:

```yaml
targets:
  $default:
    builders:
      blocks_codegen|blocks_codegen:
        options:
          spec: lib/blocks.spec.json
          # Logical identities from x-blocks-native-packages that keep the
          # UnknownTransferable fallback instead of a declared type (optional).
          # An identity the spec does not declare only warns, as AWSBLOCKS-NATIVE-006
          native_package_opt_out:
            - example-iot-native
```

### 3. Generate your client

```bash
dart run build_runner build
```

This produces a typed Dart client from your spec.

### 4. Use it

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'blocks.blocks.dart';

final blocks = Blocks(baseUrl: 'http://localhost:3001/aws-blocks/api');
final greeting = await blocks.hello.greet(name: 'World');
print(greeting.message); // "Hello, World!"
```

## Using Auth

An `Auth` block's `createApi()` export (here `authApi`) is a state machine: `getAuthState()` returns the current `state`, the signed-in `user` and the `actions` the user can take next, and `setAuthState(input: ...)` submits one of them. Use it for everything except the federated sign-in buttons: whether the user is signed in, email and password sign-in, sign-up, confirmation codes, MFA steps and `unavailable` actions. Its result is the next state: the confirmation, MFA and password-reset steps only appear there, never in `getAuthState()`, which returns only `signedIn` or `signedOut`. Call `getAuthState()` on launch and after a federated sign-in or sign-out.

Federated sign-in and sign-out go through the `OidcClient` the block's `createOidcApi()` export (here `oidcApi`) returns from `getClient()`. Render one sign-in button per provider in that client's `providers`, and have it call `oidc.signIn(provider)`. Don't render the state machine's `signIn:<id>` actions as buttons: their `url` starts a browser-cookie flow whose cookie never reaches the app, and the client already lists the providers it can sign in with. A provider whose discovery failed on the server is left out of `providers`, so it gets no button. Call `getClient()` once per block and keep that client for the app's lifetime.

```ts
// aws-blocks/index.ts
export const authApi = auth.createApi();
export const oidcApi = auth.createOidcApi();
```

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';
import 'blocks.blocks.dart'; // the generated client

const rpcUrl = 'https://api.example.com/aws-blocks/api';

// FlutterSecureStore uses a platform channel: in main(), before it.
WidgetsFlutterBinding.ensureInitialized();
final session = PersistentSessionStore(store: FlutterSecureStore());
await session.load();
final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);
// Listed in the block's redirects.allowedRelayOrigins.
const relayTo = 'com.example.app://auth';

// On launch: the state of the session the cookie store kept, and the
// block's OIDC client. Both calls throw when the backend can't be reached,
// so show the error and offer a retry.
AuthState? state;
TypedOidcClient<OidcApiGetClientProvider>? oidc;
String? error;
try {
  state = await blocks.authApi.getAuthState();
  oidc = await blocks.oidcApi.getClient();
} on Exception catch (e) {
  error = 'Could not reach the server: $e';
}

/// The federated sign-in buttons: one per provider the client can sign in
/// with, as the generated enum.
List<OidcApiGetClientProvider> get signInButtons => [
  for (final name in oidc?.providers ?? const <String>[])
    ?OidcApiGetClientProvider.fromProviderName(name),
];

/// What a federated sign-in button runs.
Future<void> signInWith(OidcApiGetClientProvider provider) async {
  error = null;
  await oidc!.signIn(
    provider,
    launcher: FlutterBrowserLauncher(),
    relayTo: relayTo,
  );
  state = await blocks.authApi.getAuthState();
}

/// Runs [action] with the [values] the user typed into its fields. Render
/// every action but the `signIn:<id>` ones, which [signInButtons] replaces,
/// and render an action that carries `unavailable` disabled, with that text,
/// so it never gets here.
Future<void> run(AuthAction action, Map<String, String> values) async {
  error = null;
  if (action.name == 'signOut' && action.url != null) {
    // A federated sign-out. Never submit it through setAuthState, which
    // drops the IdP's logout URL. Open that URL to end the IdP's session too.
    final logoutUrl = await oidc!.signOut();
    if (logoutUrl != null) await launchUrl(logoutUrl);
    state = await blocks.authApi.getAuthState();
  } else {
    // A plain action. Its result is the next state, such as
    // confirmingSignUp after a sign-up.
    final next = await blocks.authApi.setAuthState(
      input: switch (action.name) {
        'signIn' => SignInInput(
          username: values['username']!,
          password: values['password']!,
        ),
        'signUp' => SignUpInput(
          username: values['username']!,
          password: values['password']!,
          // Every field other than username and password, such as `email`,
          // goes in additionalProperties.
          additionalProperties: {'email': values['email']!},
        ),
        'confirmSignUp' => ConfirmSignUpInput(
          username: values['username']!,
          code: values['code']!,
        ),
        // Offered after confirmSignUp when the block signs the user in
        // automatically: submit it to finish signing in.
        'autoSignIn' => AutoSignInInput(username: values['username']!),
        // ...one case for each other action the block offers.
        _ => throw UnsupportedError(action.name),
      },
    );
    // Either way, show the error, if any: a wrong password, for example.
    error = next.error;
    // A retriable failure, such as a wrong confirmation code, keeps the
    // current state and form. Anything else, including a failed sign-in, is
    // the next state.
    if (next.retriable == true) return;
    state = next;
  }
  // Render state?.state, state?.user, state?.actions and error.
}
```

- The client `getClient()` returns shares the generated client's session store and token store, so the session cookie the sign-in sets is the one every RPC call sends. It carries the block's own routes, including a custom `redirects.callbackPath` or `redirects.signOutPath`, and keeps its tokens under keys of its own block, so several `Auth` blocks can share one token store and one session store.
- When the spec names the block's providers, `getClient()` returns a `TypedOidcClient` whose `signIn` takes the generated provider enum (`OidcApiGetClientProvider` for `oidcApi.getClient`), so a provider the block doesn't have doesn't compile. `providers` holds the names the server described; `fromProviderName` turns each into the enum value, as above. A spec that names no providers returns a plain `OidcClient`, whose `signIn` takes the name.
- A retriable failure comes back as `{state: signedOut, actions: [], retriable: true, error, errorName}`. It doesn't mean the user was signed out: keep the current form and show `error`. A wrong confirmation or MFA code, a password that fails the policy, an invalid field and a server fault are retriable. A wrong password is not: it comes back as a signed-out state with the sign-in actions and an `error` to show.
- A confirmation step lives only in the app: `getAuthState()` can't bring it back after the app is killed. To let the user finish confirming a sign-up, save the username when you get `confirmingSignUp`, and after a restart show the code form and submit `ConfirmSignUpInput` with it, or `ResendSignUpCodeInput` for a new code. An interrupted MFA or new-password challenge can't be resumed: sign in again.
- On launch, call `getAuthState()`. It works for every `Auth` block. `oidc.restore()` returns the same user, but only a block with sign-in providers serves its session route; any other answers 404.
- Disable an action that carries `unavailable`, and show its text.
- Never submit a `signOut` action that has a `url` through `setAuthState`: that drops the identity provider's logout URL. Call `oidc.signOut()` instead.
- `signOut()` returns the identity provider's logout URL, or null. The SDK doesn't open it. Whatever the outcome, it signs out locally: it clears this block's tokens and session cookie and emits `OidcSignedOut`. Then a 503 `SignOutIncompleteException` throws an `ApiException` with that `name`, so `isBlocksError(e, 'SignOutIncompleteException')` is true; any other failed status throws an `ApiException` with the status and the server's error name; a request with no response throws a `TransportException`; and a cancelled request passes its own error through.
- Hide actions whose `capability` is `webauthn-get` or `webauthn-create` (passkeys). This SDK doesn't run WebAuthn ceremonies.
- New actions can appear in a later version of the block. Render or skip actions you don't know by `name`, and don't fail on them.
- For `relayTo` on mobile, prefer a verified App Link (Android) or Universal Link (iOS) over a bare custom scheme. Another app can register the same custom scheme and receive the relay redirect; with a custom scheme, PKCE is what stops it from using the code, because only this app holds the verifier.
- Sign in with `signIn`. `signInDirect`, the direct flow, sends the IdP a custom-scheme `redirect_uri`, which most identity providers reject.

### Federated sign-in on each platform

| Platform | How `signIn` gets the redirect | What to pass |
|---|---|---|
| iOS, Android | The app's custom scheme | `launcher: FlutterBrowserLauncher()` and a `relayTo` in the block's `redirects.allowedRelayOrigins` |
| macOS, Linux, Windows | A loopback listener on `127.0.0.1` | Nothing: `oidc.signIn(OidcApiGetClientProvider.google)` |
| Web | Not supported: a browser app signs in on its own origin | |

A sign-in that ends without a redirect throws `OidcCancelledException`, on every platform:

- Pass `cancel:` to `signIn` or `signInDirect` to stop waiting early, for example when the user closes the sign-in dialog: `signIn(OidcApiGetClientProvider.google, cancel: dialogClosed.future)`. When it completes before the redirect arrives, the client stops waiting, the loopback listener closes, and a launcher gets the same `cancel` future so it can stop too.
- `FlutterBrowserLauncher` throws it when the app comes back to the foreground without a redirect, which is how it notices that the user closed the browser, and once its optional `timeout` passes: `FlutterBrowserLauncher(timeout: const Duration(minutes: 5))`.
- The loopback sign-in throws it once `oidc.signInTimeout` passes.
- A custom `BrowserLauncher` should throw it when its browser is dismissed.

On desktop, a call without a `launcher` binds `127.0.0.1` on a port the operating system picks, relays to `http://127.0.0.1:<port>/oidc/callback` (the backend allows a loopback relay target without an `allowedRelayOrigins` entry), opens the browser and waits for the redirect. A `launcher`, when passed, always wins.

- `oidc.openBrowser` sets how the browser opens. It defaults to the platform's URL handler (`open`, `xdg-open` or `rundll32`). A Flutter desktop app should set it, for example to `url_launcher`, throwing when no browser opened, and handle the error `signIn` then throws:

  ```dart
  oidc.openBrowser = (url) async {
    if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
      throw StateError('No browser to sign in with');
    }
  };
  ```

- `oidc.signInTimeout` (default 5 minutes) bounds the wait. When it passes, `signIn` throws `OidcCancelledException`. Both fields apply only to a call without a `launcher`.
- For a command-line app: when the default handler can't open a browser, for example on a Linux host with no `xdg-open`, the client prints a one-time `http://127.0.0.1:<port>/oidc/start/<random>` URL to stderr and keeps waiting. Opening it redirects to the sign-in page. Treat it like the sign-in link itself: it works once, for this sign-in only. On Windows, `rundll32` usually exits 0 even when nothing opened, so this fallback rarely runs there. A Flutter app has no stderr to read, which is why it should set `openBrowser`.
- A sandboxed macOS app needs the `com.apple.security.network.server` entitlement to accept the redirect on its listener, and should set `openBrowser` to `url_launcher`, because the sandbox can stop it from running `open`.

## Features

**Type-safe API calls** — every method, parameter, and return type is generated from your spec. Typos and type mismatches are caught at compile time.

**Realtime subscriptions** — if your backend has realtime channels (e.g., cursor tracking, live updates), the generated client gives you typed `Stream<T>` subscriptions over WebSocket.

**Auth flows**: each auth action's input is its own class in a sealed union, so a misspelled field or action doesn't compile. `AuthState.state` is an enum, and its actions arrive at runtime, so render them by name and skip the ones you don't know.

**File transfers** — presigned upload/download URLs are wrapped in handle objects with simple `.upload(bytes)` / `.download()` methods.

**Typed OIDC providers**: for a custom block whose method returns an OIDC client, when the spec names its providers, the method returns a `TypedOidcClient` of an enum generated for it, so `signIn` accepts only those providers and a typo doesn't compile:

```dart
final oidc = await blocks.auth.getClient(); // TypedOidcClient<AuthApiGetClientProvider>
final user = await oidc.signIn(
  AuthApiGetClientProvider.google,
  launcher: launcher,
  relayTo: 'com.example.app://auth',
);
```

The enum is named `<Api class><Method>Provider`. Each value carries the name the backend knows the provider by (`loginGov` is `'login.gov'`), and `fromProviderName(name)` finds a value from a name known only at runtime. A `TypedOidcClient` is the runtime's `OidcClient` with those three methods narrowed, so every other member works as before. A spec that names no providers, a client inside a model, and a client built with `OidcClient(...)` are a plain `OidcClient`, which takes the provider's name: `signIn('google', …)`.

**Unbound transferables** — a direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of untyped `dynamic`. Only bare direct results are covered.

**Declared native packages** — when `x-blocks-native-bindings` binds the tag and its package has a `dart` field, the client imports the declared library and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

**Errors**: every error the runtime throws is a `BlocksException`, the same taxonomy as the Kotlin and Swift clients:

| Type | When | Fields |
|---|---|---|
| `ApiException` | The server considered the request and said no: a JSON-RPC error at any HTTP status, or an auth route refusing a request | `message` (the server's), `status`, `name`, `retriable` |
| `TransportException` | No usable JSON-RPC result came back: no response (refused connection, DNS, TLS, timeout), a non-2xx with no JSON-RPC error, or a body that is not a JSON-RPC envelope | `message`, `statusCode` (null when no response arrived), `cause` |
| `ClientClosedException` | A call after `Blocks.close()` (or `BlocksClient.close()`), including a call of an `OidcClient` one of its calls returned | `message` |
| `TransferableException` | A `__blocks` descriptor could not be hydrated; `InvalidDescriptorException` names the `blocksType` and `missingField` | `message` |
| `FileTransferException` | A file upload or download failed | `message`, `statusCode`, `cause` |
| `RealtimeException` (sealed) | `RealtimeChannelClosedException` on a subscribe after close, `RealtimeConnectionException` when the WebSocket fails | `message`, `cause` |
| `OidcException` (sealed) | The OIDC sign-in flow itself failed (callback, cancelled, unknown provider, exchange) | `message`, `cause` |

Match a server error by name with `isBlocksError(e, 'ConditionalCheckFailedException')`, as on the server and in the TypeScript client. Don't branch on `status == 500`: a named error thrown without a status arrives as a 500 with its name intact. JSON-RPC's reserved codes are reported as 500, and when the server sends no name for one, the client fills in its name (`ParseError`, `InvalidRequest`, `MethodNotFound`, `InvalidParams` or `InternalError`). A method with no return value gets an envelope with no `result` and returns null.

**HTTP status**: a JSON-RPC error is an `ApiException` whatever the HTTP status, so a backend namespace created with `httpErrorStatus: true` (which answers a 4xx `ApiError` with that HTTP status) decodes the same. One difference to plan for: when the client has an `authProvider` (bearer tokens), any HTTP 401 makes it call `onAuthFailure()` (a token refresh) and run the method **once more**. Without `httpErrorStatus` an `ApiError` 401 arrives as HTTP 200 and is not retried; with it, a method that rejects with 401 after a side effect runs twice, so put the guard first on the backend: call `auth.requireAuth(context)` before anything else in the method, or wrap the method with `auth.protect` (`Auth`), which runs the guard before any of the method's code. A method that can still answer 401 after a write should be idempotent.

**No Flutter dependency** — `blocks_runtime` is pure Dart. Works in CLI apps, server-side Dart, or Flutter.

## Project structure

```
native/dart/
├── packages/
│   ├── blocks_runtime/          # Runtime library (ships with your app)
│   ├── blocks_codegen/          # Code generator (build-time only)
│   └── blocks_runtime_flutter/  # Flutter integration (secure storage, browser launcher)
├── example/                     # Demo Flutter app with auth, todos, realtime cursors
└── README.md
```

## Requirements

- Dart 3.3+
- Flutter (for the demo app — the SDK itself is pure Dart)
- Node.js 22+ (for running the AWS Blocks backend locally)

## How the codegen works

The generator has three stages:

1. **Parse** — reads the OpenRPC JSON spec, extracts methods, schemas, and type relationships
2. **Build** — resolves types, deduplicates identical shapes, groups methods into namespaces
3. **Generate** — outputs Dart source with data classes, sealed hierarchies, API methods, and a `Blocks` facade

The output is a single self-contained `.blocks.dart` file. For backends with realtime or file features, it also imports `blocks_runtime` for WebSocket and presigned URL support.

## License

Apache-2.0
