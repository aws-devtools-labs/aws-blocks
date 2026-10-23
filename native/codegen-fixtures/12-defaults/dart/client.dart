// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

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


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<CreateItemResult> createItem() async {
    final result = await _client.call('api.createItem', const <dynamic>[]);
    return CreateItemResult.fromJson(result as Map<String, dynamic>);
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

