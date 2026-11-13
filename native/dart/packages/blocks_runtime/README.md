# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

## Configuration

`BlocksConfig` holds the values a client is configured with: the backend URL and the HTTP timeouts. It is immutable and compares by value, so vary one value across environments with `copyWith`:

```dart
const prod = BlocksConfig(baseUrl: 'https://api.example.com/aws-blocks/api');
final staging = prod.copyWith(
  baseUrl: 'https://staging.example.com/aws-blocks/api',
);
final slowNetwork = prod.copyWith(idleTimeout: const Duration(minutes: 2));

final blocks = Blocks.fromConfig(staging); // generated client
final client = BlocksClient.fromConfig(slowNetwork); // runtime client
```

| Value | Default | Meaning |
|---|---|---|
| `baseUrl` | (required) | The URL calls are sent under, ending in `/aws-blocks/api`. |
| `connectTimeout` | 30 seconds | How long to wait for a connection before the call fails. |
| `idleTimeout` | 60 seconds | How long a call may go with nothing arriving (no response headers, or no next chunk of the body) before it fails. There is no cap on a call's total time. |

A call that times out throws a `TimeoutException` (see [Timeouts](#timeouts)). The config's timeouts apply to the RPC calls of the client built from it. An `http.Client` passed to `BlocksClient.fromConfig(config, client: ...)` is used as it is, without them, and file uploads and downloads and `OidcClient` keep the default timeouts. `Blocks(baseUrl: ...)` and `BlocksClient(baseUrl: ...)` still work and use the defaults.

To reach a dev server on the host machine from an Android emulator, rewrite its URL with `rewriteLocalhost(url, host: '10.0.2.2')`. `BlocksConfig.rewriteLocalhost` is deprecated and forwards to it.

## User-agent attribution

Outbound requests carry an `aws-blocks-dart` token so AWS telemetry can attribute traffic.

On web the token is dropped on every path. The RPC hop omits `x-blocks-user-agent` because the header is non-safelisted, so a browser can only send it once the server adds `x-blocks-user-agent` to its CORS allowlist.

The presigned upload and download set `User-Agent`, which browsers ignore because it is a forbidden header name. The WebSocket upgrade omits it because browsers do not allow custom headers on the upgrade request.

## Timeouts

HTTP requests the runtime makes with its own client (RPC calls, OIDC auth routes, and file uploads and downloads) fail with a `TimeoutException` from `dart:async` when they stop making progress:

- 30 seconds to connect.
- 60 seconds without progress: no request body sent, no response headers, or no response body bytes. There is no limit on a request's total time, so a large file transfer that keeps moving is not cut off.

The connect timeout applies only to the default dart:io client. Other clients (the browser, and clients such as `cupertino_http` or `cronet_http` chosen with `http.runWithClient`) send a request body in one piece, so the runtime cannot see the connection or upload progress. On those, the response headers must arrive within 60 seconds plus the time to send the body at 16 KiB per second, and the response body is timed as above.

A client you pass to `BlocksClient` or `OidcClient` is used as is, with its own timeout behavior. The `OidcClient` a generated client decodes, and file uploads and downloads, always use the runtime's own client with the default timeouts. Realtime WebSocket connections are not covered.

## License

Apache 2.0
