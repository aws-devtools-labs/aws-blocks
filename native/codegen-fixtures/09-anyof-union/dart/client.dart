// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

// --- API Namespaces ---

class SearchResult {
  final int count;

  const SearchResult({
    required this.count,
  });

  factory SearchResult.fromJson(Map<String, dynamic> json) {
    return SearchResult(
      count: (json['count'] as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'count': count,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SearchResult &&
          count == other.count;

  @override
  int get hashCode => count.hashCode;

  @override
  String toString() => 'SearchResult(count: $count)';
}


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<SearchResult> search({required dynamic query}) async {
    final params = <dynamic>[
      query,
    ];
    final result = await _client.call('api.search', params);
    return SearchResult.fromJson(result as Map<String, dynamic>);
  }

  Future<dynamic> getValue() async {
    final result = await _client.call('api.getValue', const <dynamic>[]);
    return result as dynamic;
  }
}


// --- CDK Blocks Client ---

class Blocks {
  late final Api api;
  late final BlocksClient _client;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    _client = client;
    api = Api(client);
  }

  /// Closes the client. A call after this throws a [ClientClosedException],
  /// and so does an `OidcClient` one of its calls returned. Closing twice
  /// does nothing more.
  void close() => _client.close();
}

