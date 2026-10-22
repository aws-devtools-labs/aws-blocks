// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class ApiSetScoreInput {
  final num score;
  final int level;
  final num step;

  ApiSetScoreInput({
    required this.score,
    required this.level,
    required this.step,
  }) {
    if (!(score >= 0)) throw ArgumentError('score must be >= 0');
    if (!(score <= 100)) throw ArgumentError('score must be <= 100');
    if (!(level > 0)) throw ArgumentError('level must be > 0');
    if (!(step % 0.5 == 0)) throw ArgumentError('step must be a multiple of 0.5');
  }

  factory ApiSetScoreInput.fromJson(Map<String, dynamic> json) {
    return ApiSetScoreInput(
      score: json['score'] as num,
      level: (json['level'] as num).toInt(),
      step: json['step'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'score': score,
      'level': level,
      'step': step,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiSetScoreInput &&
          score == other.score &&
          level == other.level &&
          step == other.step;

  @override
  int get hashCode => Object.hash(score, level, step);

  @override
  String toString() => 'ApiSetScoreInput(score: $score, level: $level, step: $step)';
}


class SetScoreResult {
  final bool ok;

  const SetScoreResult({
    required this.ok,
  });

  factory SetScoreResult.fromJson(Map<String, dynamic> json) {
    return SetScoreResult(
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
      other is SetScoreResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'SetScoreResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<SetScoreResult> setScore({required ApiSetScoreInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.setScore', params);
    return SetScoreResult.fromJson(result as Map<String, dynamic>);
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

