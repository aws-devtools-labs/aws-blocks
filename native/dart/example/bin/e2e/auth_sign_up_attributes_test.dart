import 'package:blocks_runtime/blocks_runtime.dart' show blocksDeepEquals;

import 'harness.dart';

/// Sign-up attributes through the `Auth` block's state machine (`createApi()`),
/// as the Authenticator sends them, on native-bindings' Cognito-style block.
///
/// The `signUp` action is an open record: `username` and `password` are its
/// properties, and every other key is a user attribute, flat beside them on the
/// wire (`{"action":"signUp","username":…,"password":…,"email":…,"name":…}`).
/// The server reads them with a rest spread, so an attribute only reaches the
/// user when it is sent flat. The generated `SignUpInput` keeps them in
/// `additionalProperties`.
///
/// The round trip runs against any backend. The sign-up leg reads the
/// confirmation code back from the local dev server, so it runs locally only.
void main() async {
  final blocks = createBlocks();

  _roundTripFlat();

  if (isLocalEndpoint()) {
    await _signUpAttributesReachTheUser(blocks);
  } else {
    group(
      'Auth (Cognito-style): setAuthState signUp attributes reach the user',
    );
    skip(needsLocalCode);
  }

  printResults();
}

/// The generated `SignUpInput` encodes its attributes flat and decodes them
/// back, and a typed key (or the `action` discriminator) wins over an
/// attribute of the same name.
void _roundTripFlat() {
  group('Auth: setAuthState signUp attributes round-trip flat');
  const signUp = SignUpInput(
    username: 'ada',
    password: e2ePassword,
    additionalProperties: {
      'email': 'ada@example.com',
      'custom:team': 'engines',
    },
  );
  final wire = {
    'action': 'signUp',
    'username': 'ada',
    'password': e2ePassword,
    'email': 'ada@example.com',
    'custom:team': 'engines',
  };

  final encoded = signUp.toJson();
  check(
    blocksDeepEquals(encoded, wire),
    'toJson() puts the attributes flat beside username and password '
    '(got: $encoded)',
  );
  final decoded = AuthBasicApiSetAuthStateInput.fromJson(wire);
  check(
    decoded == signUp,
    'fromJson() of the flat wire form gives the same SignUpInput '
    '(got: $decoded)',
  );

  const smuggled = SignUpInput(
    username: 'ada',
    password: e2ePassword,
    additionalProperties: {'action': 'signIn', 'username': 'mallory'},
  );
  final json = smuggled.toJson();
  check(
    json['action'] == 'signUp' && json['username'] == 'ada',
    'an attribute named like the discriminator or a property is not sent '
    '(got: $json)',
  );
}

/// Signs up through `authCognitoApi.setAuthState` with an email and a name,
/// confirms with the delivered code, signs in and reads the attributes back.
Future<void> _signUpAttributesReachTheUser(Blocks blocks) async {
  group('Auth (Cognito-style): setAuthState signUp attributes reach the user');
  final username = uniqueUsername('attrs');
  final email = '$username@example.com';

  final state = await blocks.authCognitoApi.setAuthState(
    input: SignUpInput(
      username: username,
      password: e2ePassword,
      additionalProperties: {'email': email, 'name': 'Ada Lovelace'},
    ),
  );
  check(
    state.state == AuthStateState.confirmingSignUp,
    'setAuthState(signUp) awaits confirmation (got: ${state.state})',
  );

  final code = await blocks.api.cognitoGetLastCode(username: username);
  check(code != null, 'a confirmation code was delivered');
  if (code == null) return;
  final confirm = await blocks.api.cognitoConfirmSignUp(
    username: username,
    code: code.code,
  );
  check(confirm.success, 'confirmSignUp returns success');
  await blocks.api.cognitoSignIn(username: username, password: e2ePassword);

  final attributes = await blocks.api.cognitoGetUserAttributes();
  check(
    attributes['email'] == email,
    'the email attribute reached the user (got: ${attributes['email']})',
  );
  check(
    attributes['name'] == 'Ada Lovelace',
    'the name attribute reached the user (got: ${attributes['name']})',
  );
  check(
    !attributes.containsKey('additionalProperties'),
    'no attribute is named after the Dart field',
  );
  await blocks.api.cognitoSignOut();
}
