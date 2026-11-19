// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@TestOn('browser')
library;

import 'package:blocks_runtime/src/web_socket_connect.dart';
import 'package:test/test.dart';

void main() {
  // connectWebSocket's web variant is selected by a conditional import the
  // compiler resolves, so it only runs on a browser platform. Run with
  // `dart test -p chrome`.
  test('connectWebSocket runs on web without dart:io', () async {
    // Calling it is what surfaces an unsupported dart:io symbol. The connection
    // to a closed port is expected to fail, so the stream and `ready` errors
    // are absorbed; otherwise they surface as an unhandled async error.
    final channel = connectWebSocket(
      Uri.parse('ws://127.0.0.1:1/'),
      const {},
      handshakeTimeout: const Duration(seconds: 30),
    );
    channel.stream.listen((_) {}, onError: (Object _) {}, cancelOnError: true);
    await channel.ready.then<void>((_) {}, onError: (Object _) {});
  });
}
