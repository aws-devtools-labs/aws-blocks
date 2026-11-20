// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

// --- API Namespaces ---

class CreateItemResult {
  final String role;
  final bool active;
  final int retries;

  const CreateItemResult({
    required this.role,
    required this.active,
    required this.retries,
  });

  factory CreateItemResult.fromJson(Map<String, dynamic> json) {
    return CreateItemResult(
      role: json['role'] as String,
      active: json['active'] as bool,
      retries: (json['retries'] as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'role': role,
      'active': active,
      'retries': retries,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CreateItemResult &&
          role == other.role &&
          active == other.active &&
          retries == other.retries;

  @override
  int get hashCode => Object.hash(role, active, retries);

  @override
  String toString() => 'CreateItemResult(role: $role, active: $active, retries: $retries)';
}


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<CreateItemResult> createItem() async {
    final result = await _client.call('api.createItem', const <dynamic>[]);
    return CreateItemResult.fromJson(result as Map<String, dynamic>);
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

