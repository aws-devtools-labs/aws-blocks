// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

enum MfaChallengeAction {
  mfa
;

  String toJson() => name;
  static MfaChallengeAction fromJson(String json) => values.byName(json);
}


class MfaChallenge {
  final MfaChallengeAction action;
  final String code;
  final String session;

  const MfaChallenge({
    required this.action,
    required this.code,
    required this.session,
  });

  factory MfaChallenge.fromJson(Map<String, dynamic> json) {
    return MfaChallenge(
      action: MfaChallengeAction.fromJson(json['action'] as String),
      code: json['code'] as String,
      session: json['session'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'action': action.toJson(),
      'code': code,
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MfaChallenge &&
          action == other.action &&
          code == other.code &&
          session == other.session;

  @override
  int get hashCode => Object.hash(action, code, session);

  @override
  String toString() => 'MfaChallenge(action: $action, code: $code, session: $session)';
}


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

