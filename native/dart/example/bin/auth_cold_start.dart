import 'dart:convert';
import 'dart:io';

import 'package:blocks_example/blocks_client.dart';
import 'package:blocks_runtime/blocks_runtime.dart';

/// Cold-start sign-in with an `Auth` block, as a command-line app.
///
/// Every run is a fresh launch. It loads the saved session, asks the server
/// for the auth state with `getAuthState()`, prints it, and then runs at most
/// one action:
///
/// ```text
/// dart run bin/auth_cold_start.dart                      # show the state
/// dart run bin/auth_cold_start.dart sign-up <user> <password> <email>
/// dart run bin/auth_cold_start.dart confirm <user> <code>
/// dart run bin/auth_cold_start.dart sign-in <user> <password>
/// dart run bin/auth_cold_start.dart sign-out
/// ```
///
/// It targets the email and password `Auth` block of
/// `test-apps/native-bindings` (`authBasicApi`). `BLOCKS_URL` overrides the
/// endpoint and `BLOCKS_SESSION_FILE` the file the session is saved in.
Future<void> main(List<String> args) async {
  final url =
      Platform.environment['BLOCKS_URL'] ??
      'http://localhost:3001/aws-blocks/api';
  final sessionFile =
      Platform.environment['BLOCKS_SESSION_FILE'] ??
      '.dart_tool/auth_cold_start_session.json';

  // The default session store keeps cookies in memory, so every launch would
  // start signed out. Persist them, and load what the last launch saved before
  // the first request.
  final session = PersistentSessionStore(
    store: JsonFileTokenStore(sessionFile),
  );
  await session.load();
  final blocks = Blocks(baseUrl: url, sessionStore: session);
  final auth = blocks.authBasicApi;

  // On launch, the server decides whether the saved session cookie is still
  // signed in. The client keeps no auth state of its own between launches.
  final state = await auth.getAuthState();
  stdout.writeln('On launch: ${describe(state)}');

  if (args.isEmpty) return;
  final command = args.first;
  final params = args.skip(1).toList();

  // The action name each command maps to, and its setAuthState input.
  final parsed = switch ((command, params)) {
    ('sign-up', [final username, final password, final email]) => (
      'signUp',
      SignUpInput(
        username: username,
        password: password,
        additionalProperties: {'email': email},
      ),
    ),
    ('confirm', [final username, final code]) => (
      'confirmSignUp',
      ConfirmSignUpInput(username: username, code: code),
    ),
    ('sign-in', [final username, final password]) => (
      'signIn',
      SignInInput(username: username, password: password),
    ),
    ('sign-out', []) => ('signOut', const SignOutInput()),
    _ => null,
  };
  if (parsed == null) {
    stderr.writeln(
      'Unknown command: ${args.join(' ')}\n'
      'Commands: sign-up <user> <password> <email>, confirm <user> <code>, '
      'sign-in <user> <password>, sign-out',
    );
    exitCode = 64;
    return;
  }
  final (actionName, input) = parsed;

  // Only submit what the state offers. An action carrying `unavailable` is
  // shown but can't be used. A signed-in user, for example, is offered
  // signOut and not signIn.
  //
  // Confirming a sign-up is the exception: getAuthState() only ever answers
  // signedIn or signedOut, and the confirmingSignUp state that offers
  // confirmSignUp came back from the sign-up call, in an earlier launch.
  final action = state.actions.where((a) => a.name == actionName).firstOrNull;
  if (actionName != 'confirmSignUp' &&
      (action == null || action.unavailable != null)) {
    stderr.writeln(
      '$actionName is not available now'
      '${action?.unavailable != null ? ': ${action!.unavailable}' : ''}',
    );
    exitCode = 1;
    return;
  }

  var next = await auth.setAuthState(input: input);
  if (!report(actionName, next)) return;

  // Confirming the code does not sign the user in by itself. The next state
  // offers autoSignIn, which signs in without asking for the password again.
  if (input is ConfirmSignUpInput &&
      next.actions.any((a) => a.name == 'autoSignIn')) {
    next = await auth.setAuthState(
      input: AutoSignInInput(username: input.username),
    );
    report('autoSignIn', next);
  }
}

/// Prints the state an action led to and returns whether it succeeded.
///
/// A retriable failure, such as a wrong code, leaves the user where they
/// were. Any other failure, such as a wrong password, comes back as the
/// state to show next, with an `error`.
bool report(String actionName, AuthState next) {
  if (next.retriable ?? false) {
    stderr.writeln('$actionName failed: ${next.error}');
    exitCode = 1;
    return false;
  }
  stdout.writeln('After $actionName: ${describe(next)}');
  if (next.error != null) {
    stderr.writeln('$actionName failed: ${next.error}');
    exitCode = 1;
    return false;
  }
  return true;
}

/// One line for a state: who is signed in, or what comes next.
String describe(AuthState state) {
  final who = state.user == null ? '' : ' as ${state.user!.username}';
  final actions = [
    for (final a in state.actions)
      if (a.capability == null) a.name,
  ];
  return '${state.state.name}$who (actions: ${actions.join(', ')})';
}

/// A [TokenStore] that keeps its entries in a JSON file.
///
/// Enough for a command-line example. The file holds the session cookie in
/// plain text, so an app should keep it in the platform's secure storage
/// instead, such as `FlutterSecureStore` from `blocks_runtime_flutter`.
///
/// It writes synchronously. [PersistentSessionStore] does not wait for its
/// writes, and a short-lived process can exit before a pending async write
/// finishes.
class JsonFileTokenStore implements TokenStore {
  JsonFileTokenStore(String path) : _file = File(path);

  final File _file;

  Map<String, String> _read() {
    if (!_file.existsSync()) return {};
    final decoded = jsonDecode(_file.readAsStringSync());
    return (decoded as Map<String, dynamic>).cast<String, String>();
  }

  void _write(Map<String, String> entries) {
    _file.parent.createSync(recursive: true);
    _file.writeAsStringSync(jsonEncode(entries));
  }

  @override
  Future<String?> get(String key) async => _read()[key];

  @override
  Future<void> set(String key, String value) async =>
      _write(_read()..[key] = value);

  @override
  Future<void> delete(String key) async => _write(_read()..remove(key));
}
