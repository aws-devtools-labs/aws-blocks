// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

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


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

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


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

