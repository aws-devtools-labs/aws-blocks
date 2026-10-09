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

  Future<(num, num, String)> getCoords() async {
    final result = await _client.call('api.getCoords', const <dynamic>[]);
    return ((result as List<dynamic>)[0] as num, (result as List<dynamic>)[1] as num, (result as List<dynamic>)[2] as String);
  }

  Future<(String, int)> getPair() async {
    final result = await _client.call('api.getPair', const <dynamic>[]);
    return ((result as List<dynamic>)[0] as String, ((result as List<dynamic>)[1] as num).toInt());
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

