# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

## File transfers

`FileUploadHandle` and `FileDownloadHandle` wrap a presigned URL. `upload(bytes)` and `download()` hold the whole file in memory. To stream it instead:

```dart
// Upload from any byte stream. Pass contentLength to send a Content-Length
// header; leave it out to send the body chunked.
await uploadHandle.uploadFrom(source, contentLength: length);

// Download into any StreamSink. The sink is not closed for you.
final sink = File('photo.jpg').openWrite();
await downloadHandle.downloadTo(sink);
await sink.close();

// Or use a file path (not available on the web).
await uploadHandle.uploadFromFile('photo.jpg');
await downloadHandle.downloadToFile('photo.jpg');
```

If the backend created the upload handle with a `contentLength` option, the size is signed into the URL and the upload must send exactly that many bytes. Pass the same value as `contentLength`. A source that yields more or fewer bytes fails the upload before the request completes. `uploadFromFile` sends the file's size.

`downloadToFile` is atomic: it writes to a new file in the same directory and renames it over the path when the download completes, so the path holds either the previous file or the whole download. `downloadTo` writes into the sink as bytes arrive, so a failed download leaves what was already written in the sink.

On the web, package:http's browser client reads the whole request body into memory before sending, so `uploadFrom` does not save memory there. The file-path methods throw `UnsupportedError` on the web.

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
