import 'package:web_socket_channel/web_socket_channel.dart';

import 'web_socket_connect_web.dart'
    if (dart.library.io) 'web_socket_connect_io.dart'
    as platform;

WebSocketChannel connectWebSocket(Uri uri, Map<String, String> headers) =>
    platform.connectWebSocket(uri, headers);
