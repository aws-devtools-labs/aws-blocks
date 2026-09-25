import 'package:web_socket_channel/web_socket_channel.dart';

import 'user_agent.dart';
import 'web_socket_connect.dart';

/// Manages pooled WebSocket connections keyed by URL.
class WebSocketPool {
  final Map<String, _PoolEntry> _pool = {};

  /// Acquires or creates a WebSocket connection for the given URL.
  WebSocketChannel acquire(String url) {
    final entry = _pool[url];
    if (entry != null) {
      entry.refCount++;
      return entry.channel;
    }
    // The WebSocket upgrade bypasses http.Client, so the User-Agent is
    // passed onto the upgrade request through connectWebSocket.
    final channel = connectWebSocket(Uri.parse(url), {
      'User-Agent': blocksUserAgentToken,
    });
    _pool[url] = _PoolEntry(channel: channel, refCount: 1);
    return channel;
  }

  /// Releases a reference to the connection. Closes it when refCount hits 0.
  void release(String url) {
    final entry = _pool[url];
    if (entry == null) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.channel.sink.close();
      _pool.remove(url);
    }
  }
}

class _PoolEntry {
  final WebSocketChannel channel;
  int refCount;
  _PoolEntry({required this.channel, required this.refCount});
}
