# AWS Blocks Dart

The Dart SDK for AWS Blocks.

AWS Blocks lets you define a backend in TypeScript (APIs, auth, databases, realtime channels, file storage) and deploy it to AWS. This SDK gives your Flutter app a typed client that talks to that backend with zero boilerplate.

## How it works

You write your backend. AWS Blocks generates a spec file describing your API. This SDK reads that spec and produces a Dart client with typed methods, models, and realtime subscriptions, ready to drop into your Flutter app.

```
Your backend (TypeScript)  →  blocks.spec.json  →  blocks_codegen  →  Typed Dart client
```

## What you get

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com/aws-blocks/api');

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
```

## Packages

| Package | Role |
|---------|------|
| **blocks_runtime** | The runtime your app ships with: HTTP client, WebSocket realtime, file handles, OIDC client |
| **blocks_codegen** | The code generator: reads your spec, outputs Dart. Only runs at build time. |
| **blocks_runtime_flutter** | Flutter support: keeps the session in the platform's secure storage, and opens the browser for OIDC sign-in |

## Getting started

You need Node.js 22 or later for the backend, and Flutter 3.41 or later (Dart 3.11 or later) for the app.

### 1. Create a backend

Create a backend with the `api-only` template, which has no web frontend:

```bash
npm create @aws-blocks/blocks-app@latest my-backend -- --template api-only
cd my-backend
npm run dev
```

`npm run dev` starts a local development server for the API at `http://localhost:3001/aws-blocks/api`. Leave it running.

### 2. Generate the spec

In a second terminal, in `my-backend`:

```bash
npm run spec
```

This writes `aws-blocks/blocks.spec.json`, which describes every method the backend exports. It also records the URL of the dev server that last ran, so the generated client calls it by default. Run `npm run spec` again after you change the backend. To point the client at AWS instead, deploy a sandbox with `npm run sandbox:deploy` and then run `BLOCKS_SPEC_STAGE=sandbox npm run spec`; the spec then names the deployed API URL, stage segment included. `npm run sandbox:destroy` deletes the sandbox.

### 3. Add the packages to your app

Create the app and add the packages:

```bash
flutter create my_app
cd my_app
```

```yaml
# pubspec.yaml
dependencies:
  blocks_runtime: ^0.2.0
  blocks_runtime_flutter: ^0.2.0

dev_dependencies:
  blocks_codegen: ^0.2.0
  build_runner: ^2.4.0
```

`blocks_runtime_flutter` keeps the session in the platform's secure storage (see [Sessions](#sessions)). A pure Dart program needs only `blocks_runtime`.

### 4. Generate the client

Copy the spec into `lib/` and run the builder:

```bash
cp ../my-backend/aws-blocks/blocks.spec.json lib/
dart run build_runner build
```

The builder turns every `*.spec.json` file in the package into a `*.blocks.dart` file next to it, here `lib/blocks.blocks.dart`. It needs no `build.yaml`; add one only to set the builder's options (see [blocks_codegen](packages/blocks_codegen/README.md#options)). Copy the spec and run the builder again whenever the backend changes.

### 5. Use it

```dart
import 'blocks.blocks.dart';

Future<void> main() async {
  // With no baseUrl, the client calls the server the spec names. Pass
  // baseUrl: 'https://<your API>/aws-blocks/api' to call another one.
  final blocks = Blocks();
  final health = await blocks.api.health();
  print(health.status.name); // ok
}
```

`api` is the backend's `export const api = new ApiNamespace(...)`: each export becomes a field of the generated `Blocks` class, and each method a Dart method with named parameters.

Before you run the app:

- **macOS:** a Flutter macOS app runs in the App Sandbox, which blocks outgoing connections until you add the `com.apple.security.network.client` entitlement to `macos/Runner/DebugProfile.entitlements` and `macos/Runner/Release.entitlements`. Without it every call throws a `TransportException`.

  ```xml
  <key>com.apple.security.network.client</key>
  <true/>
  ```

- **Android emulator:** `localhost` is the emulator itself. `BlocksConfig.rewriteLocalhost(Servers.local, host: '10.0.2.2')` gives the URL of the dev server on the host machine, to pass as `baseUrl`.

## Using Auth

An `Auth` block's `createApi()` export (here `authApi`) is a state machine: `getAuthState()` returns the current `state`, the signed-in `user` and the `actions` the user can take next, and `setAuthState(input: ...)` submits one of them. Use it for everything except the federated sign-in buttons: whether the user is signed in, email and password sign-in, sign-up, confirmation codes, MFA steps and `unavailable` actions. Its result is the next state: the confirmation, MFA and password-reset steps only appear there, never in `getAuthState()`, which returns only `signedIn` or `signedOut`. Call `getAuthState()` on launch and after a federated sign-in or sign-out.

Federated sign-in and sign-out go through the `OidcClient` the block's `createOidcApi()` export (here `oidcApi`) returns from `getClient()`. Render one sign-in button per provider in that client's `providers`, and have it call `oidc.signIn(provider)`. Don't render the state machine's `signIn:<id>` actions as buttons: their `url` starts a browser-cookie flow whose cookie never reaches the app, and the client already lists the providers it can sign in with. A provider whose discovery failed on the server is left out of `providers`, so it gets no button. Call `getClient()` once per block and keep that client for the app's lifetime.

```ts
// aws-blocks/index.ts
export const authApi = auth.createApi();
export const oidcApi = auth.createOidcApi();
```

The sample below is a `ChangeNotifier` a Flutter widget can listen to. It opens the identity provider's logout URL with `url_launcher`, so add that package to your app's `dependencies` too.

An `Auth` block on the default store signs in through its `providers` only once it is deployed. To sign in through a provider while running locally, give the provider to a `store: 'builtin'` block with `stubIdp()`, and export that block's `createOidcApi()`; the `Auth` block's README has the details.

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

import 'blocks.blocks.dart'; // the generated client

/// The app's sign-in state, driven by an `Auth` block's two exports.
class AuthModel extends ChangeNotifier {
  AuthModel(this.blocks);

  final Blocks blocks;

  // Listed in the block's redirects.allowedRelayOrigins.
  static const relayTo = 'com.example.app://auth';

  AuthState? state;
  TypedOidcClient<OidcApiGetClientProvider>? oidc;
  String? error;

  /// On launch: the state of the session the store kept, and the block's
  /// OIDC client. Both calls throw when the backend can't be reached, so show
  /// the error and offer a retry.
  Future<void> load() async {
    try {
      state = await blocks.authApi.getAuthState();
      oidc = await blocks.oidcApi.getClient();
    } on BlocksException catch (e) {
      error = 'Could not reach the server: ${e.message}';
    }
    notifyListeners();
  }

  /// The federated sign-in buttons: one per provider the client can sign in
  /// with, as the generated enum.
  List<OidcApiGetClientProvider> get signInButtons => [
    for (final name in oidc?.providers ?? const <String>[])
      ?OidcApiGetClientProvider.fromProviderName(name),
  ];

  /// What a federated sign-in button runs. On iOS and Android the browser
  /// returns through [relayTo]; on macOS, Linux and Windows the client signs
  /// in through a loopback listener and needs no launcher.
  Future<void> signInWith(OidcApiGetClientProvider provider) async {
    error = null;
    final mobile =
        defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.android;
    try {
      await oidc!.signIn(
        provider,
        launcher: mobile ? FlutterBrowserLauncher() : null,
        relayTo: relayTo,
      );
    } on OidcCancelledException {
      // The user closed the browser, or the sign-in timed out.
      return;
    }
    state = await blocks.authApi.getAuthState();
    notifyListeners();
  }

  /// Runs [action] with the [values] the user typed into its fields. Render
  /// every action but the `signIn:<id>` ones, which [signInButtons] replaces,
  /// and render an action that carries `unavailable` disabled, with that
  /// text, so it never gets here.
  Future<void> run(AuthAction action, Map<String, String> values) async {
    error = null;
    if (action.name == 'signOut' && action.url != null) {
      // A federated sign-out. Never submit it through setAuthState, which
      // drops the IdP's logout URL. Open that URL to end the IdP's session
      // too.
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
            // Every other field the action lists goes in
            // additionalProperties.
            additionalProperties: {
              for (final MapEntry(:key, :value) in values.entries)
                if (key != 'username' && key != 'password') key: value,
            },
          ),
          'confirmSignUp' => ConfirmSignUpInput(
            username: values['username']!,
            code: values['code']!,
          ),
          // Offered after confirmSignUp when the block signs the user in
          // automatically: submit it to finish signing in.
          'autoSignIn' => AutoSignInInput(username: values['username']!),
          'signOut' => const SignOutInput(),
          // ...one case for each other action the block offers.
          _ => throw UnsupportedError(action.name),
        },
      );
      // Either way, show the error, if any: a wrong password, for example.
      error = next.error;
      // A retriable failure, such as a wrong confirmation code, keeps the
      // current state and form. Anything else, including a failed sign-in,
      // is the next state.
      if (next.retriable != true) state = next;
    }
    // Render state?.state, state?.user, state?.actions and error.
    notifyListeners();
  }
}
```

- The client `getClient()` returns shares the generated client's session store and token store, so the session cookie the sign-in sets is the one every RPC call sends. It carries the block's own routes, including a custom `redirects.callbackPath` or `redirects.signOutPath`, and keeps its tokens under keys of its own block, so several `Auth` blocks can share one token store and one session store.
- When the spec names the block's providers, `getClient()` returns a `TypedOidcClient` whose `signIn` takes the generated provider enum (`OidcApiGetClientProvider` for `oidcApi.getClient`), so a provider the block doesn't have doesn't compile. `providers` holds the names the server described; `fromProviderName` turns each into the enum value, as above. A spec that names no providers returns a plain `OidcClient`, whose `signIn` takes the name.
- A retriable failure comes back as `{state: signedOut, actions: [], retriable: true, error, errorName}`. It doesn't mean the user was signed out: keep the current form and show `error`. A wrong confirmation or MFA code, a password that fails the policy, an invalid field and a server fault are retriable. A wrong password is not: it comes back as a signed-out state with the sign-in actions and an `error` to show.
- A confirmation step lives only in the app: `getAuthState()` can't bring it back after the app is killed. To let the user finish confirming a sign-up, save the username when you get `confirmingSignUp`, and after a restart show the code form and submit `ConfirmSignUpInput` with it, or `ResendSignUpCodeInput` for a new code. An interrupted MFA or new-password challenge can't be resumed: sign in again.
- On launch, call `getAuthState()`. It works for every `Auth` block. `oidc.restore()` returns the same user, but only a block with sign-in providers serves its session route; any other answers 404.
- Disable an action that carries `unavailable`, and show its text.
- Never submit a `signOut` action that has a `url` through `setAuthState`: that drops the identity provider's logout URL. Call `oidc.signOut()` instead.
- `signOut()` returns the identity provider's logout URL, or null. The SDK doesn't open it. Whatever the outcome, it signs out locally: it clears this block's tokens and session cookie and emits `OidcSignedOut`. A 503 `SignOutIncompleteException`, any other failed status, a transport error or a cancelled request then throws.
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
- Pass `cancel:` to stop waiting early, for example when the user closes the sign-in dialog: `oidc.signIn(OidcApiGetClientProvider.google, cancel: dialogClosed.future)`. When it completes before the redirect arrives, the listener closes and `signIn` throws `OidcCancelledException`.
- For a command-line app: when the default handler can't open a browser, for example on a Linux host with no `xdg-open`, the client prints a one-time `http://127.0.0.1:<port>/oidc/start/<random>` URL to stderr and keeps waiting. Opening it redirects to the sign-in page. Treat it like the sign-in link itself: it works once, for this sign-in only. On Windows, `rundll32` usually exits 0 even when nothing opened, so this fallback rarely runs there. A Flutter app has no stderr to read, which is why it should set `openBrowser`.
- A sandboxed macOS app needs the `com.apple.security.network.server` entitlement to accept the redirect on its listener, and should set `openBrowser` to `url_launcher`, because the sandbox can stop it from running `open`.

## Sessions

When the backend signs a user in, it sets a session cookie, and the client sends it back on every later call. Where that cookie is kept depends on the platform, the same way it does in the Swift and Kotlin SDKs:

| Where the app runs | Where the session is kept |
|---|---|
| Flutter on Android, iOS, macOS, Linux or Windows, with `blocks_runtime_flutter` | The platform's secure storage, through `flutter_secure_storage` (the Keystore on Android, the Keychain on iOS and macOS). The user stays signed in after the app restarts. |
| Flutter web, or Dart compiled for the web | The browser's own cookie jar, for a backend on the app's own origin. The browser never shows the session cookie to Dart. |
| A pure Dart program (command-line tool, server) | Memory, unless the program registers a store (see below). |

A Flutter app needs no code for this. Add the dependency:

```yaml
dependencies:
  blocks_runtime: ^0.2.0
  blocks_runtime_flutter: ^0.2.0
```

and build the client as usual, before or after `runApp`. The app does not have to call `WidgetsFlutterBinding.ensureInitialized()` first:

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com/aws-blocks/api');
// Signed in if the user was signed in before the app restarted.
final state = await blocks.authApi.getAuthState();
```

`blocks_runtime_flutter` registers itself as a Dart plugin, so Flutter sets up the secure store before `main` runs. Every `Blocks` (and `BlocksClient` or `OidcClient`) built without a `sessionStore:` then shares that one store. It reads the saved session before the first call, and writes it back only when the backend changes a cookie. If the secure storage cannot be read or written, the call still goes ahead with the session held in memory, and the error is passed to `FlutterError.reportError` as a silent error, so a crash reporter hooked to `FlutterError.onError` sees it.

macOS, Android and Linux each need some app setup for the secure storage to work, or to keep the session safe: the macOS `keychain-access-groups` entitlement, Android backup rules, and the libsecret runtime on Linux. See [Platform setup](packages/blocks_runtime_flutter/README.md#platform-setup).

Flutter does not run plugin registration under `flutter test`, so widget and unit tests keep the session in memory. An `integration_test` run on a device does register it, and keeps the session between runs.

To keep the session in memory only, so that it ends when the process does, pass `InMemorySessionStore()`:

```dart
final blocks = Blocks(
  baseUrl: 'https://your-api.example.com/aws-blocks/api',
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
  final blocks = Blocks(baseUrl: 'https://your-api.example.com/aws-blocks/api');
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

**Auth flows**: each auth action's input is its own class in a sealed union, so a misspelled field or action doesn't compile. `AuthState.state` is an enum, and its actions arrive at runtime, so render them by name and skip the ones you don't know.

**File transfers**: presigned upload/download URLs are wrapped in handle objects with simple `.upload(bytes)` / `.download()` methods.

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

**Unbound transferables**: a direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of untyped `dynamic`. Only bare direct results are covered.

**Declared native packages**: when `x-blocks-native-bindings` binds the tag and its package has a `dart` field, the client imports the declared library and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

**Errors and HTTP status** — a JSON-RPC error is thrown as a `BlocksRpcException` (with `code` and `data`) whatever the HTTP status, so a backend namespace created with `httpErrorStatus: true` (which answers a 4xx `ApiError` with that HTTP status) decodes the same. One difference to plan for: when the client has an `authProvider` (bearer tokens), any HTTP 401 makes it call `onAuthFailure()` (a token refresh) and run the method **once more**. Without `httpErrorStatus` an `ApiError` 401 arrives as HTTP 200 and is not retried; with it, a method that rejects with 401 after a side effect runs twice, so put the guard first on the backend: call `auth.requireAuth(context)` before anything else in the method, or wrap the method with `auth.protect` (`Auth`), which runs the guard before any of the method's code. A method that can still answer 401 after a write should be idempotent.

**No Flutter dependency**: `blocks_runtime` is pure Dart. Works in CLI apps, server-side Dart, or Flutter.

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
- Node.js 22+, for running the AWS Blocks backend locally

## How the codegen works

The generator has three stages:

1. **Parse**: reads the OpenRPC JSON spec, extracts methods, schemas, and type relationships
2. **Build**: resolves types, deduplicates identical shapes, groups methods into namespaces
3. **Generate**: outputs Dart source with data classes, sealed hierarchies, API methods, and a `Blocks` facade

The output is a single `.blocks.dart` file that imports `blocks_runtime` and re-exports the runtime types an app uses most, such as `ApiException`, `isBlocksError` and `OidcClient`, so most code needs only that one import.

## License

Apache-2.0
