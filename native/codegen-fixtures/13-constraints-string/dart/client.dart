// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class ApiCreateUserInput {
  final String email;
  final String code;
  final String? nickname;

  ApiCreateUserInput({
    required this.email,
    required this.code,
    this.nickname,
  }) {
    if (!(email.length >= 5)) throw ArgumentError('email must be at least 5 characters');
    if (!(email.length <= 254)) throw ArgumentError('email must be at most 254 characters');
    if (!(RegExp(r'^[A-Z]{3}$').hasMatch(code))) throw ArgumentError('code must match pattern');
    if (nickname case final nickname?) {
      if (!(nickname.length >= 2)) throw ArgumentError('nickname must be at least 2 characters');
      if (!(nickname.length <= 30)) throw ArgumentError('nickname must be at most 30 characters');
    }
  }

  factory ApiCreateUserInput.fromJson(Map<String, dynamic> json) {
    return ApiCreateUserInput(
      email: json['email'] as String,
      code: json['code'] as String,
      nickname: json['nickname'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'email': email,
      'code': code,
      if (nickname != null) 'nickname': nickname,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCreateUserInput &&
          email == other.email &&
          code == other.code &&
          nickname == other.nickname;

  @override
  int get hashCode => Object.hash(email, code, nickname);

  @override
  String toString() => 'ApiCreateUserInput(email: $email, code: $code, nickname: $nickname)';
}


class CreateUserResult {
  final bool ok;

  const CreateUserResult({
    required this.ok,
  });

  factory CreateUserResult.fromJson(Map<String, dynamic> json) {
    return CreateUserResult(
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
      other is CreateUserResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'CreateUserResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<CreateUserResult> createUser({required ApiCreateUserInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.createUser', params);
    return CreateUserResult.fromJson(result as Map<String, dynamic>);
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

