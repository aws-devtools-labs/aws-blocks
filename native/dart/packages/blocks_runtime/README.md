# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

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

### Federated sign-in on each platform

| Platform | How `signInRelay` gets the redirect | What to pass |
|---|---|---|
| iOS, Android | The app's custom scheme | `launcher: FlutterBrowserLauncher()` and a `relayTo` in the block's `redirects.allowedRelayOrigins` |
| macOS, Linux, Windows | A loopback listener on `127.0.0.1` | Nothing: `oidc.signInRelay('google')` |
| Web | Not supported: a browser app signs in on its own origin | |

On desktop, a call without a `launcher` binds `127.0.0.1` on a port the operating system picks, relays to `http://127.0.0.1:<port>/oidc/callback` (the backend allows a loopback relay target without an `allowedRelayOrigins` entry), opens the browser and waits for the redirect. A `launcher`, when passed, always wins.

- `oidc.openBrowser` sets how the browser opens. It defaults to the platform's URL handler (`open`, `xdg-open` or `rundll32`). A Flutter desktop app should set it, for example to `url_launcher`, throwing when no browser opened, and handle the error `signInRelay` then throws:

  ```dart
  oidc.openBrowser = (url) async {
    if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
      throw StateError('No browser to sign in with');
    }
  };
  ```

- `oidc.signInTimeout` (default 5 minutes) bounds the wait. When it passes, `signInRelay` throws `OidcCancelledException`. Both fields apply only to a call without a `launcher`.
- Pass `cancel:` to stop waiting early, for example when the user closes the sign-in dialog: `signInRelay('google', cancel: dialogClosed.future)`. When it completes before the redirect arrives, the listener closes and `signInRelay` throws `OidcCancelledException`.
- For a command-line app: when the default handler can't open a browser, for example on a Linux host with no `xdg-open`, the client prints a one-time `http://127.0.0.1:<port>/oidc/start/<random>` URL to stderr and keeps waiting. Opening it redirects to the sign-in page. Treat it like the sign-in link itself: it works once, for this sign-in only. On Windows, `rundll32` usually exits 0 even when nothing opened, so this fallback rarely runs there. A Flutter app has no stderr to read, which is why it should set `openBrowser`.
- A sandboxed macOS app needs the `com.apple.security.network.server` entitlement to accept the redirect on its listener, and should set `openBrowser` to `url_launcher`, because the sandbox can stop it from running `open`.

## Typed OIDC providers

This section covers custom blocks that return an OIDC client; for `Auth`, see [Using Auth](#using-auth). `OidcClient`'s `signIn`, `signInRelay` and `exchange` take a provider by the name the backend knows it by. `TypedOidcClient<P extends OidcProvider>` is an extension type over an `OidcClient` that narrows those three methods to providers of type `P`. A generated client returns one, with `P` an enum it generates from the spec's provider names, so passing a provider that client doesn't have is a compile error:

```dart
// AuthApiGetClientProvider is the enum blocks_codegen generates for a
// method `auth.getClient` whose spec names its providers.
final TypedOidcClient<AuthApiGetClientProvider> oidc =
    await blocks.auth.getClient();
await oidc.signInRelay(
  AuthApiGetClientProvider.google,
  launcher: launcher,
  relayTo: 'com.example.app://auth',
);
```

It costs nothing at runtime: it is the same object as the `OidcClient` it wraps, so it can be passed wherever an `OidcClient` is expected, and its other members are the client's own. Typed as an `OidcClient`, it takes provider names again. Because it is a compile-time view, `is TypedOidcClient` can't tell it from a plain `OidcClient` at runtime.

## User-agent attribution

Outbound requests carry an `aws-blocks-dart` token so AWS telemetry can attribute traffic.

On web the token is dropped on every path. The RPC hop omits `x-blocks-user-agent` because the header is non-safelisted, so a browser can only send it once the server adds `x-blocks-user-agent` to its CORS allowlist.

The presigned upload and download set `User-Agent`, which browsers ignore because it is a forbidden header name. The WebSocket upgrade omits it because browsers do not allow custom headers on the upgrade request.

## License

Apache 2.0
