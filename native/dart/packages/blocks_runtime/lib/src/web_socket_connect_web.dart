// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:web_socket_channel/web_socket_channel.dart';

// Browsers do not allow setting custom request headers (including User-Agent)
// on the WebSocket upgrade, so the header cannot be attached on web.
//
// The caller closes the channel when the handshake times out, which closes a
// browser WebSocket that is still connecting, so handshakeTimeout is unused.
WebSocketChannel connectWebSocket(
  Uri uri,
  Map<String, String> headers, {
  required Duration handshakeTimeout,
}) => WebSocketChannel.connect(uri);
