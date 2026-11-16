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
// Upload from any byte stream. contentLength is required: presigned upload
// URLs do not accept a chunked body.
await uploadHandle.uploadFrom(source, contentLength: length);

// In Flutter, from an XFile (image_picker, file_selector). This works on
// every platform, including the web.
await uploadHandle.uploadFrom(
  xfile.openRead(),
  contentLength: await xfile.length(),
);

// Download into any StreamConsumer, such as an IOSink or a StreamController.
// It is not closed for you.
final sink = File('photo.jpg').openWrite();
await downloadHandle.downloadTo(sink);
await sink.close();

// Or use a file path (not available on the web).
await uploadHandle.uploadFromFile('photo.jpg');
await downloadHandle.downloadToFile('photo.jpg');
```

If the backend created the upload handle with a `contentLength` option, the size is signed into the URL and the upload must send exactly that many bytes. Pass the same value as `contentLength`. A source that yields more or fewer bytes than `contentLength` fails the upload before the request completes, and a source that yields nothing for 60 seconds fails it with a `TimeoutException`. `uploadFromFile` sends the file's size.

`downloadToFile` is atomic: it writes to a new file in the same directory and renames it over the path when the download completes, so the path holds either the previous file or the whole download. It does not fsync before the rename. A process killed mid-download leaves the `<path>.<hex>.part` file behind. `downloadTo` writes into the consumer as bytes arrive, so a failed download leaves what was already written there.

On the web, package:http's browser client reads the whole request body into memory before sending, so `uploadFrom` does not save memory there. `uploadFromFile` and `downloadToFile` throw `UnsupportedError` on the web.

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

## Errors

A JSON-RPC error from the backend is thrown as a `BlocksRpcException`. Errors cross the wire by name, so match on its `name` (the server's `error.data.name`) rather than on `code` or `message`. `isBlocksError` does the check for any caught value. Here `signUp` stands for a method of your own backend. The generated client re-exports `BlocksRpcException` but not `isBlocksError`, `BlocksException` or `FileTransferException`, so import the runtime library for them:

```dart
import 'package:blocks_runtime/blocks_runtime.dart';

try {
  await blocks.api.signUp(username: username, password: password);
} catch (e) {
  if (!isBlocksError(e, 'UsernameExistsException')) rethrow;
  // The user already exists: offer to sign in instead.
}
```

To read the exception's fields as well, catch the type: `on BlocksRpcException catch (e)`, then check `e.name`.

A file transfer that gets an HTTP error status, or an upload whose source yields a different number of bytes than its `contentLength`, throws a `FileTransferException`. Its `statusCode` is the HTTP status, or null for a byte-count mismatch.

Both implement `BlocksException`, and both are `Exception`s. `BlocksException` has the `message` and the `cause` (the error that caused this one, or null). Errors from Dart and package:http are rethrown as they are: a timeout is a `TimeoutException` (see [Timeouts](#timeouts)), and a network failure is an `http.ClientException`.

`BlocksClient.close()` closes its HTTP client, including one you passed in. A call made after that fails at once with an `http.ClientException` ("Client is already closed") and sends nothing, and a call still waiting for its response fails with an `http.ClientException` too.

## License

Apache 2.0
