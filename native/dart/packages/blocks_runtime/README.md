# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

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

## Typed OIDC providers

This section covers custom blocks that return an OIDC client; for `Auth`, see [Using Auth](#using-auth). `OidcClient`'s `signInDirect`, `signIn` and `exchange` take a provider by the name the backend knows it by. `TypedOidcClient<P extends OidcProvider>` is an extension type over an `OidcClient` that narrows those three methods to providers of type `P`. A generated client returns one, with `P` an enum it generates from the spec's provider names, so passing a provider that client doesn't have is a compile error:

```dart
// AuthApiGetClientProvider is the enum blocks_codegen generates for a
// method `auth.getClient` whose spec names its providers.
final TypedOidcClient<AuthApiGetClientProvider> oidc =
    await blocks.auth.getClient();
await oidc.signIn(
  AuthApiGetClientProvider.google,
  launcher: launcher,
  relayTo: 'com.example.app://auth',
);
```

It costs nothing at runtime: it is the same object as the `OidcClient` it wraps, so it can be passed wherever an `OidcClient` is expected, and its other members are the client's own. Typed as an `OidcClient`, it takes provider names again. Because it is a compile-time view, `is TypedOidcClient` can't tell it from a plain `OidcClient` at runtime.

## User-agent attribution

Outbound requests carry an `aws-blocks-dart` token so AWS telemetry can attribute traffic.

RPC calls send it as `x-blocks-user-agent` on every platform. The header is not CORS-safelisted, so a browser preflights the call; the Blocks server has allowed it since `@aws-blocks/core` 0.6.0.

On web the token is dropped on the other paths. The presigned upload and download set `User-Agent`, which browsers ignore because it is a forbidden header name. The WebSocket upgrade omits it because browsers do not allow custom headers on the upgrade request.

## License

Apache 2.0
