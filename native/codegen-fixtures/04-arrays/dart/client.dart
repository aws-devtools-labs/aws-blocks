// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

// --- API Namespaces ---

class ListItemsResult {
  final String id;
  final String name;

  const ListItemsResult({
    required this.id,
    required this.name,
  });

  factory ListItemsResult.fromJson(Map<String, dynamic> json) {
    return ListItemsResult(
      id: json['id'] as String,
      name: json['name'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ListItemsResult &&
          id == other.id &&
          name == other.name;

  @override
  int get hashCode => Object.hash(id, name);

  @override
  String toString() => 'ListItemsResult(id: $id, name: $name)';
}


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<List<String>> listTags() async {
    final result = await _client.call('api.listTags', const <dynamic>[]);
    return (result as List<dynamic>).cast<String>();
  }

  Future<List<ListItemsResult>> listItems() async {
    final result = await _client.call('api.listItems', const <dynamic>[]);
    return (result as List<dynamic>).map((e) => ListItemsResult.fromJson(e as Map<String, dynamic>)).toList();
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

