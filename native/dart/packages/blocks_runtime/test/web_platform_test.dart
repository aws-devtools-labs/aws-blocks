@TestOn('browser')
library;

import 'package:blocks_runtime/src/rpc_user_agent_headers.dart';
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
}
