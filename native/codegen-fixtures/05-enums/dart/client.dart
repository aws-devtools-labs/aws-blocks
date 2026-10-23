// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum SetStatusResultStatus {
  active,
  inactive,
  pending
;

  String toJson() => name;
  static SetStatusResultStatus fromJson(String json) => values.byName(json);
}


// --- API Namespaces ---

enum ApiSetStatusStatus {
  active,
  inactive,
  pending
;

  String toJson() => name;
  static ApiSetStatusStatus fromJson(String json) => values.byName(json);
}


class SetStatusResult {
  final SetStatusResultStatus status;
  final String updatedAt;

  const SetStatusResult({
    required this.status,
    required this.updatedAt,
  });

  factory SetStatusResult.fromJson(Map<String, dynamic> json) {
    return SetStatusResult(
      status: SetStatusResultStatus.fromJson(json['status'] as String),
      updatedAt: json['updatedAt'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'status': status.toJson(),
      'updatedAt': updatedAt,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SetStatusResult &&
          status == other.status &&
          updatedAt == other.updatedAt;

  @override
  int get hashCode => Object.hash(status, updatedAt);

  @override
  String toString() => 'SetStatusResult(status: $status, updatedAt: $updatedAt)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<SetStatusResult> setStatus({required ApiSetStatusStatus status}) async {
    final params = <dynamic>[
      status.toJson(),
    ];
    final result = await _client.call('api.setStatus', params);
    return SetStatusResult.fromJson(result as Map<String, dynamic>);
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

