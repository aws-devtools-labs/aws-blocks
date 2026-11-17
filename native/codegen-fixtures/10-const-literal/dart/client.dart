// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 0.2.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class DoActionResult {
  final bool ok;

  const DoActionResult({
    required this.ok,
  });

  factory DoActionResult.fromJson(Map<String, dynamic> json) {
    return DoActionResult(
      ok: json['ok'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok': ok,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DoActionResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'DoActionResult(ok: $ok)';
}


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<DoActionResult> doAction({required dynamic input}) async {
    final params = <dynamic>[
      input,
    ];
    final result = await _client.call('api.doAction', params);
    return DoActionResult.fromJson(result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final Api api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = Api(client);
  }
}

