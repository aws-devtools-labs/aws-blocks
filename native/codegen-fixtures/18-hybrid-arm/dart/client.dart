// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class Todo {
  final String userId;
  final String todoId;
  final String title;
  final bool completed;
  final num priority;
  final num createdAt;

  const Todo({
    required this.userId,
    required this.todoId,
    required this.title,
    required this.completed,
    required this.priority,
    required this.createdAt,
  });

  factory Todo.fromJson(Map<String, dynamic> json) {
    return Todo(
      userId: json['userId'] as String,
      todoId: json['todoId'] as String,
      title: json['title'] as String,
      completed: json['completed'] as bool,
      priority: json['priority'] as num,
      createdAt: json['createdAt'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userId': userId,
      'todoId': todoId,
      'title': title,
      'completed': completed,
      'priority': priority,
      'createdAt': createdAt,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Todo &&
          userId == other.userId &&
          todoId == other.todoId &&
          title == other.title &&
          completed == other.completed &&
          priority == other.priority &&
          createdAt == other.createdAt;

  @override
  int get hashCode => Object.hash(userId, todoId, title, completed, priority, createdAt);

  @override
  String toString() => 'Todo(userId: $userId, todoId: $todoId, title: $title, completed: $completed, priority: $priority, createdAt: $createdAt)';
}


enum AuthStateState {
  signedOut,
  signedIn,
  confirmingSignUp,
  confirmingSignIn,
  confirmingMfa,
  confirmingPasswordReset
;

  String toJson() => name;
  static AuthStateState fromJson(String json) => values.byName(json);
}


class AuthUser {
  final String userId;
  final String username;
  final String? displayName;

  const AuthUser({
    required this.userId,
    required this.username,
    this.displayName,
  });

  factory AuthUser.fromJson(Map<String, dynamic> json) {
    return AuthUser(
      userId: json['userId'] as String,
      username: json['username'] as String,
      displayName: json['displayName'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userId': userId,
      'username': username,
      if (displayName != null) 'displayName': displayName,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthUser &&
          userId == other.userId &&
          username == other.username &&
          displayName == other.displayName;

  @override
  int get hashCode => Object.hash(userId, username, displayName);

  @override
  String toString() => 'AuthUser(userId: $userId, username: $username, displayName: $displayName)';
}


enum AuthActionMethod {
  GET,
  POST
;

  String toJson() => name;
  static AuthActionMethod fromJson(String json) => values.byName(json);
}


enum AuthActionCapability {
  webauthnGet,
  webauthnCreate
;

  static const _jsonMap = <String, AuthActionCapability>{
    'webauthn-get': webauthnGet,
    'webauthn-create': webauthnCreate,
  };
  static const _toJsonMap = <AuthActionCapability, String>{
    webauthnGet: 'webauthn-get',
    webauthnCreate: 'webauthn-create',
  };
  String toJson() => _toJsonMap[this]!;
  static AuthActionCapability fromJson(String json) => _jsonMap[json]!;
}


class AuthAction {
  final String name;
  final String label;
  final List<AuthField> fields;
  final String? url;
  final AuthActionMethod? method;
  final AuthActionCapability? capability;

  const AuthAction({
    required this.name,
    required this.label,
    required this.fields,
    this.url,
    this.method,
    this.capability,
  });

  factory AuthAction.fromJson(Map<String, dynamic> json) {
    return AuthAction(
      name: json['name'] as String,
      label: json['label'] as String,
      fields: (json['fields'] as List<dynamic>).map((e) => AuthField.fromJson(e as Map<String, dynamic>)).toList(),
      url: json['url'] as String?,
      method: json['method'] != null ? AuthActionMethod.fromJson(json['method'] as String) : null,
      capability: json['capability'] != null ? AuthActionCapability.fromJson(json['capability'] as String) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'label': label,
      'fields': fields.map((e) => e.toJson()).toList(),
      if (url != null) 'url': url,
      if (method != null) 'method': method?.toJson(),
      if (capability != null) 'capability': capability?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthAction &&
          name == other.name &&
          label == other.label &&
          blocksDeepEquals(fields, other.fields) &&
          url == other.url &&
          method == other.method &&
          capability == other.capability;

  @override
  int get hashCode => Object.hash(name, label, blocksDeepHash(fields), url, method, capability);

  @override
  String toString() => 'AuthAction(name: $name, label: $label, fields: $fields, url: $url, method: $method, capability: $capability)';
}


enum AuthFieldType {
  number,
  password,
  email,
  text,
  tel,
  hidden
;

  String toJson() => name;
  static AuthFieldType fromJson(String json) => values.byName(json);
}


class AuthField {
  final String name;
  final String label;
  final AuthFieldType type;
  final bool required$;
  final String? defaultValue;

  const AuthField({
    required this.name,
    required this.label,
    required this.type,
    required this.required$,
    this.defaultValue,
  });

  factory AuthField.fromJson(Map<String, dynamic> json) {
    return AuthField(
      name: json['name'] as String,
      label: json['label'] as String,
      type: AuthFieldType.fromJson(json['type'] as String),
      required$: json['required'] as bool,
      defaultValue: json['defaultValue'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'label': label,
      'type': type.toJson(),
      'required': required$,
      if (defaultValue != null) 'defaultValue': defaultValue,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthField &&
          name == other.name &&
          label == other.label &&
          type == other.type &&
          required$ == other.required$ &&
          defaultValue == other.defaultValue;

  @override
  int get hashCode => Object.hash(name, label, type, required$, defaultValue);

  @override
  String toString() => 'AuthField(name: $name, label: $label, type: $type, required\$: ${required$}, defaultValue: $defaultValue)';
}


sealed class ConfirmSignInInputChallenge {
  const ConfirmSignInInputChallenge();
  Map<String, dynamic> toJson();
  static ConfirmSignInInputChallenge fromJson(Map<String, dynamic> json) {
    switch (json['challenge'] as String) {
      case 'code': return CodeConfirmSignInInputChallenge.fromJson(json);
      case 'mfaType': return MfaTypeConfirmSignInInputChallenge.fromJson(json);
      case 'newPassword': return NewPasswordConfirmSignInInputChallenge.fromJson(json);
      case 'totpSetup': return TotpSetupConfirmSignInInputChallenge.fromJson(json);
      case 'email': return EmailConfirmSignInInputChallenge.fromJson(json);
      case 'password': return PasswordConfirmSignInInputChallenge.fromJson(json);
      case 'firstFactor': return FirstFactorConfirmSignInInputChallenge.fromJson(json);
      case 'webauthn': return WebauthnConfirmSignInInputChallenge.fromJson(json);
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

class MfaTypeConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String mfaType;

  const MfaTypeConfirmSignInInputChallenge({
    required this.mfaType,
  });

  factory MfaTypeConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return MfaTypeConfirmSignInInputChallenge(
      mfaType: json['mfaType'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'mfaType',
      'mfaType': mfaType,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MfaTypeConfirmSignInInputChallenge &&
          mfaType == other.mfaType;

  @override
  int get hashCode => mfaType.hashCode;

  @override
  String toString() => 'MfaTypeConfirmSignInInputChallenge(mfaType: $mfaType)';
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

class TotpSetupConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String sharedSecret;
  final String code;

  const TotpSetupConfirmSignInInputChallenge({
    required this.sharedSecret,
    required this.code,
  });

  factory TotpSetupConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return TotpSetupConfirmSignInInputChallenge(
      sharedSecret: json['sharedSecret'] as String,
      code: json['code'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'totpSetup',
      'sharedSecret': sharedSecret,
      'code': code,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TotpSetupConfirmSignInInputChallenge &&
          sharedSecret == other.sharedSecret &&
          code == other.code;

  @override
  int get hashCode => Object.hash(sharedSecret, code);

  @override
  String toString() => 'TotpSetupConfirmSignInInputChallenge(sharedSecret: $sharedSecret, code: $code)';
}

class EmailConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String email;

  const EmailConfirmSignInInputChallenge({
    required this.email,
  });

  factory EmailConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return EmailConfirmSignInInputChallenge(
      email: json['email'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'email',
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is EmailConfirmSignInInputChallenge &&
          email == other.email;

  @override
  int get hashCode => email.hashCode;

  @override
  String toString() => 'EmailConfirmSignInInputChallenge(email: $email)';
}

class PasswordConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String password;

  const PasswordConfirmSignInInputChallenge({
    required this.password,
  });

  factory PasswordConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return PasswordConfirmSignInInputChallenge(
      password: json['password'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'password',
      'password': password,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PasswordConfirmSignInInputChallenge &&
          password == other.password;

  @override
  int get hashCode => password.hashCode;

  @override
  String toString() => 'PasswordConfirmSignInInputChallenge(password: $password)';
}

class FirstFactorConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String firstFactor;

  const FirstFactorConfirmSignInInputChallenge({
    required this.firstFactor,
  });

  factory FirstFactorConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return FirstFactorConfirmSignInInputChallenge(
      firstFactor: json['firstFactor'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'firstFactor',
      'firstFactor': firstFactor,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is FirstFactorConfirmSignInInputChallenge &&
          firstFactor == other.firstFactor;

  @override
  int get hashCode => firstFactor.hashCode;

  @override
  String toString() => 'FirstFactorConfirmSignInInputChallenge(firstFactor: $firstFactor)';
}

class WebauthnConfirmSignInInputChallenge extends ConfirmSignInInputChallenge {
  final String credential;

  const WebauthnConfirmSignInInputChallenge({
    required this.credential,
  });

  factory WebauthnConfirmSignInInputChallenge.fromJson(Map<String, dynamic> json) {
    return WebauthnConfirmSignInInputChallenge(
      credential: json['credential'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'challenge': 'webauthn',
      'credential': credential,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is WebauthnConfirmSignInInputChallenge &&
          credential == other.credential;

  @override
  int get hashCode => credential.hashCode;

  @override
  String toString() => 'WebauthnConfirmSignInInputChallenge(credential: $credential)';
}



// --- API Namespaces ---

class AuthState {
  final AuthStateState state;
  final AuthUser? user;
  final List<AuthAction> actions;
  final String? error;
  final String? errorName;
  final bool? retriable;

  const AuthState({
    required this.state,
    this.user,
    required this.actions,
    this.error,
    this.errorName,
    this.retriable,
  });

  factory AuthState.fromJson(Map<String, dynamic> json) {
    return AuthState(
      state: AuthStateState.fromJson(json['state'] as String),
      user: json['user'] != null ? AuthUser.fromJson(json['user'] as Map<String, dynamic>) : null,
      actions: (json['actions'] as List<dynamic>).map((e) => AuthAction.fromJson(e as Map<String, dynamic>)).toList(),
      error: json['error'] as String?,
      errorName: json['errorName'] as String?,
      retriable: json['retriable'] as bool?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'state': state.toJson(),
      if (user != null) 'user': user?.toJson(),
      'actions': actions.map((e) => e.toJson()).toList(),
      if (error != null) 'error': error,
      if (errorName != null) 'errorName': errorName,
      if (retriable != null) 'retriable': retriable,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthState &&
          state == other.state &&
          user == other.user &&
          blocksDeepEquals(actions, other.actions) &&
          error == other.error &&
          errorName == other.errorName &&
          retriable == other.retriable;

  @override
  int get hashCode => Object.hash(state, user, blocksDeepHash(actions), error, errorName, retriable);

  @override
  String toString() => 'AuthState(state: $state, user: $user, actions: $actions, error: $error, errorName: $errorName, retriable: $retriable)';
}


sealed class AuthApiSetAuthStateInput {
  const AuthApiSetAuthStateInput();
  Map<String, dynamic> toJson();
  static AuthApiSetAuthStateInput fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'signUp': return SignUpInput.fromJson(json);
      case 'resetPassword': return ResetPasswordInput.fromJson(json);
      case 'signIn': return SignInInput.fromJson(json);
      case 'signInWithPasskey': return SignInWithPasskeyInput.fromJson(json);
      case 'confirmSignUp': return ConfirmSignUpInput.fromJson(json);
      case 'resendSignUpCode': return ResendSignUpCodeInput.fromJson(json);
      case 'signOut': return SignOutInput.fromJson(json);
      case 'confirmResetPassword': return ConfirmResetPasswordInput.fromJson(json);
      case 'autoSignIn': return AutoSignInInput.fromJson(json);
      case 'confirmSignIn': return ConfirmSignInInput.fromJson(json);
      case 'startPasskeyRegistration': return StartPasskeyRegistrationInput.fromJson(json);
      case 'completePasskeyRegistration': return CompletePasskeyRegistrationInput.fromJson(json);
      case 'listPasskeys': return ListPasskeysInput.fromJson(json);
      case 'deletePasskey': return DeletePasskeyInput.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class SignUpInput extends AuthApiSetAuthStateInput {
  final String username;
  final String password;
  final Map<String, String> additionalProperties;

  const SignUpInput({
    required this.username,
    required this.password,
    this.additionalProperties = const {},
  });

  factory SignUpInput.fromJson(Map<String, dynamic> json) {
    const knownKeys = {'action', 'username', 'password'};
    return SignUpInput(
      username: json['username'] as String,
      password: json['password'] as String,
      additionalProperties: Map.fromEntries(
        json.entries.where((e) => !knownKeys.contains(e.key))
            .map((e) => MapEntry(e.key, e.value as String)),
      ),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'signUp',
      'username': username,
      'password': password,
      for (final e in additionalProperties.entries)
        if (!const {'action', 'username', 'password'}.contains(e.key)) e.key: e.value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignUpInput &&
          username == other.username &&
          password == other.password &&
          blocksDeepEquals(additionalProperties, other.additionalProperties);

  @override
  int get hashCode => Object.hash(username, password, blocksDeepHash(additionalProperties));

  @override
  String toString() => 'SignUpInput(username: $username, password: $password, additionalProperties: $additionalProperties)';
}

class ResetPasswordInput extends AuthApiSetAuthStateInput {
  final String username;

  const ResetPasswordInput({
    required this.username,
  });

  factory ResetPasswordInput.fromJson(Map<String, dynamic> json) {
    return ResetPasswordInput(
      username: json['username'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'resetPassword',
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ResetPasswordInput &&
          username == other.username;

  @override
  int get hashCode => username.hashCode;

  @override
  String toString() => 'ResetPasswordInput(username: $username)';
}

class SignInInput extends AuthApiSetAuthStateInput {
  final String username;
  final String password;

  const SignInInput({
    required this.username,
    required this.password,
  });

  factory SignInInput.fromJson(Map<String, dynamic> json) {
    return SignInInput(
      username: json['username'] as String,
      password: json['password'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'signIn',
      'username': username,
      'password': password,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignInInput &&
          username == other.username &&
          password == other.password;

  @override
  int get hashCode => Object.hash(username, password);

  @override
  String toString() => 'SignInInput(username: $username, password: $password)';
}

class SignInWithPasskeyInput extends AuthApiSetAuthStateInput {
  final String username;

  const SignInWithPasskeyInput({
    required this.username,
  });

  factory SignInWithPasskeyInput.fromJson(Map<String, dynamic> json) {
    return SignInWithPasskeyInput(
      username: json['username'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'signInWithPasskey',
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignInWithPasskeyInput &&
          username == other.username;

  @override
  int get hashCode => username.hashCode;

  @override
  String toString() => 'SignInWithPasskeyInput(username: $username)';
}

class ConfirmSignUpInput extends AuthApiSetAuthStateInput {
  final String username;
  final String code;
  final String? password;

  const ConfirmSignUpInput({
    required this.username,
    required this.code,
    this.password,
  });

  factory ConfirmSignUpInput.fromJson(Map<String, dynamic> json) {
    return ConfirmSignUpInput(
      username: json['username'] as String,
      code: json['code'] as String,
      password: json['password'] as String?,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'confirmSignUp',
      'username': username,
      'code': code,
      if (password != null) 'password': password,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ConfirmSignUpInput &&
          username == other.username &&
          code == other.code &&
          password == other.password;

  @override
  int get hashCode => Object.hash(username, code, password);

  @override
  String toString() => 'ConfirmSignUpInput(username: $username, code: $code, password: $password)';
}

class ResendSignUpCodeInput extends AuthApiSetAuthStateInput {
  final String username;

  const ResendSignUpCodeInput({
    required this.username,
  });

  factory ResendSignUpCodeInput.fromJson(Map<String, dynamic> json) {
    return ResendSignUpCodeInput(
      username: json['username'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'resendSignUpCode',
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ResendSignUpCodeInput &&
          username == other.username;

  @override
  int get hashCode => username.hashCode;

  @override
  String toString() => 'ResendSignUpCodeInput(username: $username)';
}

class SignOutInput extends AuthApiSetAuthStateInput {

  const SignOutInput();

  factory SignOutInput.fromJson(Map<String, dynamic> json) {
    return SignOutInput(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'signOut',
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignOutInput;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'SignOutInput()';
}

class ConfirmResetPasswordInput extends AuthApiSetAuthStateInput {
  final String username;
  final String code;
  final String newPassword;

  const ConfirmResetPasswordInput({
    required this.username,
    required this.code,
    required this.newPassword,
  });

  factory ConfirmResetPasswordInput.fromJson(Map<String, dynamic> json) {
    return ConfirmResetPasswordInput(
      username: json['username'] as String,
      code: json['code'] as String,
      newPassword: json['newPassword'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'confirmResetPassword',
      'username': username,
      'code': code,
      'newPassword': newPassword,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ConfirmResetPasswordInput &&
          username == other.username &&
          code == other.code &&
          newPassword == other.newPassword;

  @override
  int get hashCode => Object.hash(username, code, newPassword);

  @override
  String toString() => 'ConfirmResetPasswordInput(username: $username, code: $code, newPassword: $newPassword)';
}

class AutoSignInInput extends AuthApiSetAuthStateInput {
  final String username;

  const AutoSignInInput({
    required this.username,
  });

  factory AutoSignInInput.fromJson(Map<String, dynamic> json) {
    return AutoSignInInput(
      username: json['username'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'autoSignIn',
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AutoSignInInput &&
          username == other.username;

  @override
  int get hashCode => username.hashCode;

  @override
  String toString() => 'AutoSignInInput(username: $username)';
}



class ConfirmSignInInput extends AuthApiSetAuthStateInput {
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

class StartPasskeyRegistrationInput extends AuthApiSetAuthStateInput {

  const StartPasskeyRegistrationInput();

  factory StartPasskeyRegistrationInput.fromJson(Map<String, dynamic> json) {
    return StartPasskeyRegistrationInput(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'startPasskeyRegistration',
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is StartPasskeyRegistrationInput;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'StartPasskeyRegistrationInput()';
}

class CompletePasskeyRegistrationInput extends AuthApiSetAuthStateInput {
  final String credential;

  const CompletePasskeyRegistrationInput({
    required this.credential,
  });

  factory CompletePasskeyRegistrationInput.fromJson(Map<String, dynamic> json) {
    return CompletePasskeyRegistrationInput(
      credential: json['credential'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'completePasskeyRegistration',
      'credential': credential,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CompletePasskeyRegistrationInput &&
          credential == other.credential;

  @override
  int get hashCode => credential.hashCode;

  @override
  String toString() => 'CompletePasskeyRegistrationInput(credential: $credential)';
}

class ListPasskeysInput extends AuthApiSetAuthStateInput {

  const ListPasskeysInput();

  factory ListPasskeysInput.fromJson(Map<String, dynamic> json) {
    return ListPasskeysInput(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'listPasskeys',
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ListPasskeysInput;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'ListPasskeysInput()';
}

class DeletePasskeyInput extends AuthApiSetAuthStateInput {
  final String credentialId;

  const DeletePasskeyInput({
    required this.credentialId,
  });

  factory DeletePasskeyInput.fromJson(Map<String, dynamic> json) {
    return DeletePasskeyInput(
      credentialId: json['credentialId'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'deletePasskey',
      'credentialId': credentialId,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DeletePasskeyInput &&
          credentialId == other.credentialId;

  @override
  int get hashCode => credentialId.hashCode;

  @override
  String toString() => 'DeletePasskeyInput(credentialId: $credentialId)';
}



class AuthApiApi {
  final BlocksClient _client;
  AuthApiApi(this._client);

  Future<AuthState> setAuthState({required AuthApiSetAuthStateInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('authApi.setAuthState', params);
    return AuthState.fromJson(result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final AuthApiApi authApi;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    authApi = AuthApiApi(client);
  }
}

