import 'package:web_socket_channel/web_socket_channel.dart';

// Browsers do not allow setting custom request headers (including User-Agent)
// on the WebSocket upgrade, so the header cannot be attached on web.
WebSocketChannel connectWebSocket(Uri uri, Map<String, String> headers) =>
    WebSocketChannel.connect(uri);
