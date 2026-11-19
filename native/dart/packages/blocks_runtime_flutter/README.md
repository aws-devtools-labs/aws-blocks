# blocks_runtime_flutter

Flutter-specific implementations for `blocks_runtime`. Provides secure token storage via `flutter_secure_storage` and OAuth browser flow via `url_launcher`.

## Usage

```dart
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
```

Use `FlutterSecureStore` to keep the session cookie in the platform's secure storage, and `FlutterBrowserLauncher` to open the identity provider's sign-in page:

`FlutterSecureStore` uses a platform channel, so call `WidgetsFlutterBinding.ensureInitialized()` in `main()` before creating it:

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/widgets.dart';
import 'blocks.blocks.dart'; // the generated client

WidgetsFlutterBinding.ensureInitialized();
final session = PersistentSessionStore(store: FlutterSecureStore());
await session.load();
final blocks = Blocks(
  baseUrl: 'https://your-api.example.com/aws-blocks/api',
  sessionStore: session,
);
final OidcClient oidc = await blocks.oidcApi.getClient();
await oidc.signIn(
  'google',
  launcher: FlutterBrowserLauncher(),
  relayTo: 'com.example.app://auth',
);
```

`FlutterBrowserLauncher` opens the sign-in page in the system browser. The browser is a separate app, and neither `url_launcher` nor `app_links` reports when the user closes it, so the launcher watches the app's lifecycle: when the app comes back to the foreground and no redirect arrives within `resumeGracePeriod` (2 seconds by default), the sign-in throws `OidcCancelledException`. It throws the same exception once its optional `timeout` passes, or when the `cancel` future passed to `signIn` completes:

```dart
try {
  await oidc.signIn(
    'google',
    launcher: FlutterBrowserLauncher(timeout: const Duration(minutes: 5)),
    relayTo: 'com.example.app://auth',
  );
} on OidcCancelledException {
  // The user closed the browser, or the sign-in timed out.
}
```

Pass `resumeGracePeriod: null` to turn the lifecycle check off, for example when the user has to switch back to the app during sign-in. It throws a `StateError` when no browser could be opened.

See "Using Auth" in the `blocks_runtime` README for the full sign-in flow.

## License

Apache 2.0
