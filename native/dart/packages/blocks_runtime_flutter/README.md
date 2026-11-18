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

See "Using Auth" in the `blocks_runtime` README for the full sign-in flow.

## License

Apache 2.0
