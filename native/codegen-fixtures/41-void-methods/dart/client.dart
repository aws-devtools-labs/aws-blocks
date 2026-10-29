// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<void> ping() async {
    await _client.call('api.ping', const <dynamic>[]);
  }

  Future<void> remember({required String note, String? tag}) async {
    final params = <dynamic>[
      note,
      if (tag != null) tag,
    ];
    await _client.call('api.remember', params);
  }

  Future<int> count() async {
    final result = await _client.call('api.count', const <dynamic>[]);
    return (result as num).toInt();
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

