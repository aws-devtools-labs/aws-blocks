// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:web_socket_channel/web_socket_channel.dart';

import 'web_socket_connect_web.dart'
    if (dart.library.io) 'web_socket_connect_io.dart'
    as platform;

/// Opens a WebSocket to [uri].
///
/// [handshakeTimeout] is when the platform gives up on a handshake that hasn't
/// finished and releases the connection attempt. The caller ends its
/// subscriptions at the same time.
WebSocketChannel connectWebSocket(
  Uri uri,
  Map<String, String> headers, {
  required Duration handshakeTimeout,
}) =>
    platform.connectWebSocket(uri, headers, handshakeTimeout: handshakeTimeout);
