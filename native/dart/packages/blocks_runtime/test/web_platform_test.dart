@TestOn('browser')
library;

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/rpc_user_agent_headers.dart';
import 'package:blocks_runtime/src/timeout_client.dart';
import 'package:blocks_runtime/src/web_socket_connect.dart';
import 'package:test/test.dart';

void main() {
  // The conditional imports are resolved by the compiler, so the web variants
  // only run on a browser platform. Run with `dart test -p chrome`.
  test('the dispatcher omits the RPC header on web', () {
    expect(rpcUserAgentHeaders(), isEmpty);
  });

  test('connectWebSocket runs on web without dart:io', () async {
    // Calling it is what surfaces an unsupported dart:io symbol. The connection
    // to a closed port is expected to fail, so the stream and `ready` errors
    // are absorbed; otherwise they surface as an unhandled async error.
    final channel = connectWebSocket(Uri.parse('ws://127.0.0.1:1/'), const {});
    channel.stream.listen((_) {}, onError: (Object _) {}, cancelOnError: true);
    await channel.ready.then<void>((_) {}, onError: (Object _) {});
  });

  test('the default HTTP client runs on web without dart:io', () async {
    // Sending is what surfaces an unsupported dart:io symbol. The closed port
    // makes the request fail, which is expected.
    final client = newBlocksHttpClient();
    await expectLater(
      client.get(Uri.parse('http://127.0.0.1:1/')),
      throwsA(anything),
    );
    client.close();
  });

  test('the file-path transfers throw UnsupportedError on web', () {
    expect(
      () => FileUploadHandle.fromJson({
        'url': 'http://127.0.0.1:1/put',
      }).uploadFromFile('a.bin'),
      throwsUnsupportedError,
    );
    expect(
      () => FileDownloadHandle.fromJson({
        'url': 'http://127.0.0.1:1/get',
      }).downloadToFile('a.bin'),
      throwsUnsupportedError,
    );
  });
}
