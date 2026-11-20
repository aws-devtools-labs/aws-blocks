// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

sealed class SetStatusResultStatus {
  static const active = SetStatusResultStatusKnown.active;
  static const inactive = SetStatusResultStatusKnown.inactive;
  static const pending = SetStatusResultStatusKnown.pending;
  static const values = SetStatusResultStatusKnown.values;
  static final Map<String, SetStatusResultStatusKnown> _byJson = SetStatusResultStatusKnown.values.asNameMap();

  String toJson();
  static SetStatusResultStatus fromJson(String json) => _byJson[json] ?? SetStatusResultStatusUnknown(json);
}

enum SetStatusResultStatusKnown implements SetStatusResultStatus {
  active,
  inactive,
  pending
;

  @override
  String toJson() => name;
}

final class SetStatusResultStatusUnknown implements SetStatusResultStatus {
  final String value;

  const SetStatusResultStatusUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is SetStatusResultStatusUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'SetStatusResultStatusUnknown' '($value)';
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


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<SetStatusResult> setStatus({required ApiSetStatusStatus status}) async {
    final params = <dynamic>[
      status.toJson(),
    ];
    final result = await _client.call('api.setStatus', params);
    return SetStatusResult.fromJson(result as Map<String, dynamic>);
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

