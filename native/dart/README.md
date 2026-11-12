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

An `Auth` block's `createApi()` export (here `authApi`) is a state machine: `getAuthState()` returns the current `state`, the signed-in `user` and the `actions` the user can take next, and `setAuthState(input: ...)` submits one of them. Render the actions and submit the plain ones (email and password sign-in, sign-up, confirmation codes) through `setAuthState`. Its result is the next state: the confirmation, MFA and password-reset steps only appear there, never in `getAuthState()`, which returns only `signedIn` or `signedOut`. Call `getAuthState()` on launch and after a federated sign-in or sign-out. Federated sign-in and sign-out go through an `OidcClient` built with `OidcClient.forAuth`, because the action's `url` starts a browser-cookie flow whose cookie never reaches the app.

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
final oidc = OidcClient.forAuth(
  BlocksClient(baseUrl: rpcUrl, sessionStore: session),
  providers: ['google'],
  relayTo: 'com.example.app://auth', // listed in the block's redirects.allowedRelayOrigins
);

// On launch: the state of the session the cookie store kept. It throws when
// the backend can't be reached, so show the error and offer a retry.
AuthState? state;
String? error;
try {
  state = await blocks.authApi.getAuthState();
} on Exception catch (e) {
  error = 'Could not reach the server: $e';
}

/// Runs [action] with the [values] the user typed into its fields.
Future<void> run(AuthAction action, Map<String, String> values) async {
  error = null;
  // Render an action that carries `unavailable` disabled, with that text,
  // so it never gets here.
  final providerId = OidcClient.providerIdOf(action.name);
  if (providerId != null) {
    // A `signIn:<id>` action.
    await oidc.signInRelay(providerId, launcher: FlutterBrowserLauncher());
    state = await blocks.authApi.getAuthState();
  } else if (action.name == 'signOut' && action.url != null) {
    // A federated sign-out. Never submit it through setAuthState, which
    // drops the IdP's logout URL. Open that URL to end the IdP's session too.
    final logoutUrl = await oidc.signOut();
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

- `forAuth` shares the session store with the generated client, so the session cookie the sign-in sets is the one every RPC call sends. It makes no network call.
- Pass `callbackPath` and `signOutPath` when the block sets `redirects.callbackPath` or `redirects.signOutPath`. The other routes are derived from `callbackPath`. Each `forAuth` client keeps its tokens under keys of its own block, so several `Auth` blocks can share one token store and one session store.
- A retriable failure comes back as `{state: signedOut, actions: [], retriable: true, error, errorName}`. It doesn't mean the user was signed out: keep the current form and show `error`. A wrong confirmation or MFA code, a password that fails the policy, an invalid field and a server fault are retriable. A wrong password is not: it comes back as a signed-out state with the sign-in actions and an `error` to show.
- A confirmation step lives only in the app: `getAuthState()` can't bring it back after the app is killed. To let the user finish confirming a sign-up, save the username when you get `confirmingSignUp`, and after a restart show the code form and submit `ConfirmSignUpInput` with it, or `ResendSignUpCodeInput` for a new code. An interrupted MFA or new-password challenge can't be resumed: sign in again.
- On launch, call `getAuthState()`. It works for every `Auth` block. `oidc.restore()` returns the same user, but only a block with sign-in providers serves its session route; any other answers 404.
- Disable an action that carries `unavailable`, and show its text.
- Never submit a `signOut` action that has a `url` through `setAuthState`: that drops the identity provider's logout URL. Call `oidc.signOut()` instead.
- `signOut()` returns the identity provider's logout URL, or null. The SDK doesn't open it. A 503 `SignOutIncompleteException` still signs out locally, then throws an `OidcRequestException` with that `errorName`.
- Hide actions whose `capability` is `webauthn-get` or `webauthn-create` (passkeys). This SDK doesn't run WebAuthn ceremonies.
- New actions can appear in a later version of the block. Render or skip actions you don't know by `name`, and don't fail on them.
- For `relayTo` on mobile, prefer a verified App Link (Android) or Universal Link (iOS) over a bare custom scheme. Another app can register the same custom scheme and receive the relay redirect; with a custom scheme, PKCE is what stops it from using the code, because only this app holds the verifier.
- Sign in with `signInRelay`. A `forAuth` client has no provider configs, so the direct `signIn` flow, which custom blocks that return provider configs still use, doesn't apply to it.

## Features

**Type-safe API calls** — every method, parameter, and return type is generated from your spec. Typos and type mismatches are caught at compile time.

**Realtime subscriptions** — if your backend has realtime channels (e.g., cursor tracking, live updates), the generated client gives you typed `Stream<T>` subscriptions over WebSocket.

**Auth flows**: each auth action's input is its own class in a sealed union, so a misspelled field or action doesn't compile. `AuthState.state` is an enum, and its actions arrive at runtime, so render them by name and skip the ones you don't know.

**File transfers** — presigned upload/download URLs are wrapped in handle objects with simple `.upload(bytes)` / `.download()` methods.

**Typed OIDC providers**: for a custom block whose method returns an OIDC client, when the spec names its providers, the method returns a `TypedOidcClient` of an enum generated for it, so `signInRelay` accepts only those providers and a typo doesn't compile:

```dart
final oidc = await blocks.auth.getClient(); // TypedOidcClient<AuthApiGetClientProvider>
final user = await oidc.signInRelay(
  AuthApiGetClientProvider.google,
  launcher: launcher,
  relayTo: 'com.example.app://auth',
);
```

The enum is named `<Api class><Method>Provider`. Each value carries the name the backend knows the provider by (`loginGov` is `'login.gov'`), and `fromProviderName(name)` finds a value from a name known only at runtime. A `TypedOidcClient` is the runtime's `OidcClient` with those three methods narrowed, so every other member works as before. A spec that names no providers, a client inside a model, and a client built with `OidcClient(...)` are a plain `OidcClient`, which takes the provider's name: `signInRelay('google', …)`.

**Unbound transferables** — a direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of untyped `dynamic`. Only bare direct results are covered.

**Declared native packages** — when `x-blocks-native-bindings` binds the tag and its package has a `dart` field, the client imports the declared library and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

**Errors and HTTP status** — a JSON-RPC error is thrown as a `BlocksRpcException` (with `code` and `data`) whatever the HTTP status, so a backend namespace created with `httpErrorStatus: true` (which answers a 4xx `ApiError` with that HTTP status) decodes the same. One difference to plan for: when the client has an `authProvider` (bearer tokens), any HTTP 401 makes it call `onAuthFailure()` (a token refresh) and run the method **once more**. Without `httpErrorStatus` an `ApiError` 401 arrives as HTTP 200 and is not retried; with it, a method that rejects with 401 after a side effect runs twice, so put the guard first on the backend: call `auth.requireAuth(context)` before anything else in the method, or wrap the method with `auth.protect` (`Auth`), which runs the guard before any of the method's code. A method that can still answer 401 after a write should be idempotent.

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
