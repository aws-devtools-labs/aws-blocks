// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

WebSocketChannel connectWebSocket(
  Uri uri,
  Map<String, String> headers, {
  required Duration handshakeTimeout,
}) {
  // dart:io prepends its own default User-Agent when the header is passed in the
  // headers map, so set it on a client we own to send the token cleanly.
  final client = HttpClient();
  final userAgent = headers['User-Agent'];
  if (userAgent != null) client.userAgent = userAgent;
  final extra = Map<String, String>.from(headers)..remove('User-Agent');
  final channel = IOWebSocketChannel.connect(
    uri,
    headers: extra.isEmpty ? null : extra,
    customClient: client,
  );
  // The upgrade detaches the socket from the client, so neither closing the
  // client nor its idleTimeout (which applies only to pooled HTTP
  // connections) affects it. The socket has no idle timeout of its own, and
  // no protocol-level pingInterval is set, so only the realtime pool's JSON
  // ping keeps it busy.
  channel.ready.whenComplete(client.close).ignore();
  // Closing the channel before the upgrade finishes doesn't abort the pending
  // request, so a server that never answers would hold the connection open.
  // Force-close the client at the deadline the caller uses to give up.
  channel.ready
      .timeout(handshakeTimeout)
      .then((_) {}, onError: (_) => client.close(force: true))
      .ignore();
  return channel;
}
