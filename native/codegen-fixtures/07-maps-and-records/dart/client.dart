// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class ApiSignUpInput {
  final String username;
  final String password;
  final Map<String, String> additionalProperties;

  const ApiSignUpInput({
    required this.username,
    required this.password,
    this.additionalProperties = const {},
  });

  factory ApiSignUpInput.fromJson(Map<String, dynamic> json) {
    const knownKeys = {'username', 'password'};
    return ApiSignUpInput(
      username: json['username'] as String,
      password: json['password'] as String,
      additionalProperties: Map.fromEntries(
        json.entries.where((e) => !knownKeys.contains(e.key))
            .map((e) => MapEntry(e.key, e.value as String)),
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'username': username,
      'password': password,
      for (final e in additionalProperties.entries)
        if (!const {'username', 'password'}.contains(e.key)) e.key: e.value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiSignUpInput &&
          username == other.username &&
          password == other.password &&
          blocksDeepEquals(additionalProperties, other.additionalProperties);

  @override
  int get hashCode => Object.hash(username, password, blocksDeepHash(additionalProperties));

  @override
  String toString() => 'ApiSignUpInput(username: $username, password: $password, additionalProperties: $additionalProperties)';
}


class SignUpResult {
  final bool ok;

  const SignUpResult({
    required this.ok,
  });

  factory SignUpResult.fromJson(Map<String, dynamic> json) {
    return SignUpResult(
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
      other is SignUpResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'SignUpResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Map<String, num>> getScores() async {
    final result = await _client.call('api.getScores', const <dynamic>[]);
    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, v as num));
  }

  Future<SignUpResult> signUp({required ApiSignUpInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.signUp', params);
    return SignUpResult.fromJson(result as Map<String, dynamic>);
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

