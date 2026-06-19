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

  Future<Map<String, dynamic>> updateAttributes({required Map<String, String> attributes}) async {
    final params = <String, dynamic>{
      'attributes': attributes,
    };
    final result = await _client.call('api.updateAttributes', params);
    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, v as dynamic));
  }

  Future<dynamic> getNotification({required String id}) async {
    final params = <String, dynamic>{
      'id': id,
    };
    final result = await _client.call('api.getNotification', params);
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

