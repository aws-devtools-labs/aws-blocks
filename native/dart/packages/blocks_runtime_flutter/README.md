# blocks_runtime_flutter

Flutter-specific implementations for `blocks_runtime`. Provides secure token storage via `flutter_secure_storage` and OAuth browser flow via `url_launcher`.

## Usage

```yaml
dependencies:
  blocks_runtime: ^1.0.0
  blocks_runtime_flutter: ^1.0.0
```

### Sessions survive app restarts

Depending on this package is all it takes. It is a Dart plugin: Flutter calls `BlocksRuntimeFlutterPlugin.registerWith()` before `main` on Android, iOS, macOS, Linux and Windows, which makes a `PersistentSessionStore` over `FlutterSecureStore` the default session store. Every `Blocks`, `BlocksClient` and `OidcClient` built without a `sessionStore:` shares it, reads the saved session before its first call, and so finds a signed-in user still signed in after a restart.

```dart
import 'package:blocks_runtime/blocks_runtime.dart';

Future<void> main() async {
  // No WidgetsFlutterBinding.ensureInitialized() needed: the secure store
  // creates the binding itself before its first read.
  final client = BlocksClient(baseUrl: 'https://your-api.example.com/cdk-blocks/api');
  await client.call('authApi.getAuthState', const []);
}
```

Nothing is registered on the web, where the browser keeps the session cookies itself.

To keep a client's session in memory only, pass `sessionStore: InMemorySessionStore()`. To do that for every client, call `registerDefaultSessionStore(null)` at the start of `main`.

When the secure storage cannot be read or written, the session keeps working from memory and the error goes to `FlutterError.reportError` as a silent error, once until storage works again. A crash reporter hooked to `FlutterError.onError` receives it; the console shows it in debug builds only.

The default store keeps its cookies under the key `_session_cookies`. If you also build your own `PersistentSessionStore(store: FlutterSecureStore())` with that key, the two overwrite each other; pass one store to every client instead. To change how the default store is built, register your own at the start of `main`, before any client exists (afterwards it throws a `StateError`). This example also depends on `flutter_secure_storage`:

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

void main() {
  registerDefaultSessionStore(
    () => PersistentSessionStore(
      store: FlutterSecureStore(
        storage: const FlutterSecureStorage(
          mOptions: MacOsOptions(usesDataProtectionKeychain: false),
        ),
      ),
      onPersistError: BlocksRuntimeFlutterPlugin.reportStorageError,
    ),
  );
  // runApp(...);
}
```

Flutter does not run plugin registration under `flutter test`, so widget and unit tests keep sessions in memory. An `integration_test` run on a device registers it, and keeps the session between runs. A background isolate that runs the plugin registrant gets a store of its own over the same key; don't sign in or out from one.

### Platform setup

The secure storage comes from `flutter_secure_storage`, which needs some setup per platform:

- **macOS:** add the `keychain-access-groups` entitlement to `macos/Runner/DebugProfile.entitlements` and `Release.entitlements`:

  ```xml
  <key>keychain-access-groups</key>
  <array/>
  ```

  Without it every read fails with `errSecMissingEntitlement` (-34018), reported as above, and the session is never saved. If the app uses an App Group, list it in the array, or writes appear to succeed but store nothing. The entitlement needs a provisioning profile: choose a development team under Signing & Capabilities in Xcode, or the build fails with `"Runner" has entitlements that require signing with a development certificate`. An app that can't have one leaves the entitlement out and registers its own default with `MacOsOptions(usesDataProtectionKeychain: false)`, as shown above.

  The App Sandbox also blocks network access by default. Add `com.apple.security.network.client` to both files so the app can reach the backend, and `com.apple.security.network.server` to `Release.entitlements` (Flutter's template has it in `DebugProfile.entitlements` only) so a desktop sign-in can receive the browser's redirect on its loopback listener:

  ```xml
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
  ```
- **Android:** set `android:allowBackup="false"` on the `<application>` element in `AndroidManifest.xml`, or exclude flutter_secure_storage's shared preferences from backup. The session is encrypted with a Keystore key that a backup does not carry, so a restored copy cannot be read and the user signs in again.
- **Linux:** the app needs the libsecret runtime (`libsecret-1-0` on Debian and Ubuntu, `libsecret` on Fedora and Arch) and a running Secret Service, such as GNOME Keyring. Install the development package (`libsecret-1-dev`) to build. Without them the session is kept in memory and the error is reported.
- **iOS and Windows:** no setup.

### Secure token storage

`FlutterSecureStore` is a `TokenStore` backed by `flutter_secure_storage` (the Keychain on iOS and macOS, the Keystore on Android). Use it for OIDC tokens, or under a `PersistentSessionStore` of your own:

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';

final tokenStore = FlutterSecureStore();
final client = BlocksClient(
  baseUrl: 'https://your-api.example.com/cdk-blocks/api',
  tokenStore: tokenStore,
);
```

### OIDC sign-in

`FlutterBrowserLauncher` is the `BrowserLauncher` that opens the identity provider's sign-in page and returns the callback URL to `OidcClient.signIn` or `signInDirect`. Use it on iOS and Android, with a `relayTo` listed in the block's `redirects.allowedRelayOrigins`. On macOS, Linux and Windows, call `signIn` without a launcher to sign in through a loopback listener instead (see "Using Auth" in the `blocks_runtime` README).

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'blocks.blocks.dart'; // the generated client

/// Signs in with Google. Returns false when the user closed the browser.
Future<bool> signIn(Blocks blocks) async {
  final oidc = await blocks.oidcApi.getClient();
  try {
    await oidc.signIn(
      OidcApiGetClientProvider.google,
      launcher: FlutterBrowserLauncher(),
      relayTo: 'com.example.app://auth',
    );
    return true;
  } on OidcCancelledException {
    return false;
  }
}
```

`FlutterBrowserLauncher` opens the sign-in page in the system browser. The browser is a separate app, and neither `url_launcher` nor `app_links` reports when the user closes it, so the launcher watches the app's lifecycle: when the app comes back to the foreground and no redirect arrives within `resumeGracePeriod` (2 seconds by default), the sign-in throws `OidcCancelledException`. It throws the same exception once its optional `timeout` passes (`FlutterBrowserLauncher(timeout: const Duration(minutes: 5))`), or when the `cancel` future passed to `signIn` completes. `OidcCancelledException` comes from `blocks_runtime`, which the generated client does not re-export, hence the first import.

Pass `resumeGracePeriod: null` to turn the lifecycle check off, for example when the user has to switch back to the app during sign-in. It throws a `StateError` when no browser could be opened.

On desktop, omit the launcher to use loopback sign-in. See [Using Auth](../blocks_runtime/README.md#using-auth) for the full flow and desktop browser options.

## License

Apache 2.0
