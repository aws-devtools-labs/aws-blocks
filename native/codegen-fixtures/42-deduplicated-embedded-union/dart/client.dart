// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 0.1.5 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

sealed class ConfirmSignInInputChallenge {
  const ConfirmSignInInputChallenge();
  Map<String, dynamic> toJson();
  static ConfirmSignInInputChallenge fromJson(Map<String, dynamic> json) {
    switch (json['challenge'] as String) {
      case 'code': return CodeConfirmSignInInputChallenge.fromJson(json);
      case 'newPassword': return NewPasswordConfirmSignInInputChallenge.fromJson(json);
      default: throw ArgumentError('Unknown challenge: ${json['challenge']}');
    }
  }
}

class CodeConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String code;

  const CodeConfirmSignInInputChallenge({
    required this.code,
  });

  factory CodeConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return CodeConfirmSignInInputChallenge(
      code: json['code'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'code',
      'code': code,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CodeConfirmSignInInputChallenge &&
          code == other.code;

  @override
  int get hashCode => code.hashCode;

  @override
  String toString() => 'CodeConfirmSignInInputChallenge(code: $code)';
}

class NewPasswordConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String newPassword;

  const NewPasswordConfirmSignInInputChallenge({
    required this.newPassword,
  });

  factory NewPasswordConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return NewPasswordConfirmSignInInputChallenge(
      newPassword: json['newPassword'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'newPassword',
      'newPassword': newPassword,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is NewPasswordConfirmSignInInputChallenge &&
          newPassword == other.newPassword;

  @override
  int get hashCode => newPassword.hashCode;

  @override
  String toString() => 'NewPasswordConfirmSignInInputChallenge(newPassword: $newPassword)';
}



sealed class AlphaApiSetStateInput {
  const AlphaApiSetStateInput();
  Map<String, dynamic> toJson();
  static AlphaApiSetStateInput fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'signIn': return SignInInput.fromJson(json);
      case 'confirmSignIn': return ConfirmSignInInput.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class SignInInput extends AlphaApiSetStateInput {
  final String username;

  const SignInInput({
    required this.username,
  });

  factory SignInInput.fromJson(Map<String, dynamic> json) {
    return SignInInput(
      username: json['username'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'signIn',
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignInInput &&
          username == other.username;

  @override
  int get hashCode => username.hashCode;

  @override
  String toString() => 'SignInInput(username: $username)';
}



class ConfirmSignInInput extends AlphaApiSetStateInput {
  final String session;
  final ConfirmSignInInputChallenge challenge;

  const ConfirmSignInInput({
    required this.session,
    required this.challenge,
  });

  factory ConfirmSignInInput.fromJson(Map<String, dynamic> json) {
    return ConfirmSignInInput(
      session: json['session'] as String,
      challenge: ConfirmSignInInputChallenge.fromJson(json),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'confirmSignIn',
      'session': session,
      ...challenge.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ConfirmSignInInput &&
          session == other.session &&
          challenge == other.challenge;

  @override
  int get hashCode => Object.hash(session, challenge);

  @override
  String toString() => 'ConfirmSignInInput(session: $session, challenge: $challenge)';
}



// --- API Namespaces ---

class AlphaApiApi {
  final BlocksClient _client;
  AlphaApiApi(this._client);

  Future<bool> setState({required AlphaApiSetStateInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('alphaApi.setState', params);
    return result as bool;
  }
}


class BetaApiApi {
  final BlocksClient _client;
  BetaApiApi(this._client);

  Future<bool> setState({required AlphaApiSetStateInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('betaApi.setState', params);
    return result as bool;
  }
}


// --- Blocks Client ---

class Blocks {
  late final AlphaApiApi alphaApi;
  late final BetaApiApi betaApi;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    alphaApi = AlphaApiApi(client);
    betaApi = BetaApiApi(client);
  }
}

