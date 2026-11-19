// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:http/http.dart' as http;

/// Whether a `BlocksClient` is closed, shared with the `OidcClient`s
/// hydrated from its results, so they fail the same way after `close()`.
///
/// Not exported.
final class ClientLifetime {
  bool _closed = false;

  /// The HTTP clients of the `OidcClient`s linked to this lifetime, closed
  /// with it. Weak, so a linked client the app dropped can be collected.
  final List<WeakReference<http.Client>> _clients = [];

  bool get isClosed => _closed;

  /// Closes [client] when this lifetime ends, or at once if it has.
  void closeWith(http.Client client) {
    if (_closed) {
      client.close();
      return;
    }
    _clients
      ..removeWhere((ref) => ref.target == null)
      ..add(WeakReference(client));
  }

  void close() {
    if (_closed) return;
    _closed = true;
    for (final ref in _clients) {
      ref.target?.close();
    }
    _clients.clear();
  }
}

/// The lifetime of the `BlocksClient` whose result held each `oidc/client`
/// descriptor, keyed by the descriptor map itself. A generated client passes
/// that same map to `OidcClient.fromJson`, which finds the lifetime here.
final Expando<ClientLifetime> descriptorLifetimes = Expando(
  'descriptorLifetimes',
);

/// Records [lifetime] on every `oidc/client` descriptor in [result], at any
/// depth.
void linkOidcDescriptors(Object? result, ClientLifetime lifetime) {
  switch (result) {
    case Map<String, dynamic>():
      if (result['__blocks'] == 'oidc/client') {
        descriptorLifetimes[result] = lifetime;
      }
      result.values.forEach((v) => linkOidcDescriptors(v, lifetime));
    case List<dynamic>():
      result.forEach((v) => linkOidcDescriptors(v, lifetime));
  }
}
