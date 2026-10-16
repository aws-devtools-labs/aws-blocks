// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class EchoResult {
  final String text;
  final int count;
  final num score;
  final bool enabled;

  const EchoResult({
    required this.text,
    required this.count,
    required this.score,
    required this.enabled,
  });

  factory EchoResult.fromJson(Map<String, dynamic> json) {
    return EchoResult(
      text: json['text'] as String,
      count: (json['count'] as num).toInt(),
      score: json['score'] as num,
      enabled: json['enabled'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'text': text,
      'count': count,
      'score': score,
      'enabled': enabled,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is EchoResult &&
          text == other.text &&
          count == other.count &&
          score == other.score &&
          enabled == other.enabled;

  @override
  int get hashCode => Object.hash(text, count, score, enabled);

  @override
  String toString() => 'EchoResult(text: $text, count: $count, score: $score, enabled: $enabled)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<EchoResult> echo({required String text, required int count, required num score, required bool enabled}) async {
    final params = <dynamic>[
      text,
      count,
      score,
      enabled,
    ];
    final result = await _client.call('api.echo', params);
    return EchoResult.fromJson(result as Map<String, dynamic>);
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

