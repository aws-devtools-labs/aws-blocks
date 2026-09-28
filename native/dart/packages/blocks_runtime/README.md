# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

## User-agent attribution

Outbound requests carry an `aws-blocks-dart` token so AWS telemetry can attribute traffic.

On web, two paths drop it. The RPC hop omits `x-blocks-user-agent` because the header is non-safelisted, so a browser can only send it once the server adds `x-blocks-user-agent` to its CORS allowlist. The WebSocket upgrade omits `User-Agent` because browsers do not allow custom headers on the upgrade request.

## License

Apache 2.0
