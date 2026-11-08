import 'browser_launcher.dart';
import 'oidc_auth_state.dart';
import 'oidc_client.dart';
import 'oidc_exception.dart';

/// A provider a [TypedOidcClient] can sign in with.
///
/// A generated client implements it with an enum per method whose spec names
/// the providers (`AuthApiGetClientProvider.google`). Each value's
/// [providerName] is the name the backend knows the provider by, which is
/// what reaches the wire.
abstract interface class OidcProvider {
  /// The name the backend knows this provider by: a key of the descriptor's
  /// `providers`, sent in the authorize-params path and the exchange body.
  String get providerName;
}

/// An [OidcClient] whose [signIn], [signInRelay] and [exchange] take only the
/// providers of type [P], the enum a generated client generates for a method
/// whose spec names its providers:
///
/// ```dart
/// final oidc = await blocks.auth.getClient(); // TypedOidcClient<AuthApiGetClientProvider>
/// final user = await oidc.signInRelay(
///   AuthApiGetClientProvider.google,
///   launcher: launcher,
///   relayTo: 'com.example.app://auth',
/// );
/// ```
///
/// Passing a string, or a provider the method's spec didn't name, is a
/// compile error. For a name known only at runtime, such as one read from a
/// saved session, use the enum's `fromProviderName`.
///
/// It is the same object as the [OidcClient] it wraps, with no cost at
/// runtime: every other member ([refresh], [signOut], [authStateChanges],
/// [toJson], …) is the client's own, and it can be passed wherever an
/// [OidcClient] is expected. Typed as an [OidcClient], it takes provider
/// names again, and throws [OidcUnknownProviderException] for a name the
/// backend doesn't list. Being a compile-time view, it can't be told apart
/// from a plain [OidcClient] at runtime (`is TypedOidcClient` checks only
/// for an [OidcClient]), and a `dynamic` call reaches the [OidcClient]
/// methods, so passing a generated value through `dynamic` throws a
/// `TypeError`.
extension type TypedOidcClient<P extends OidcProvider>(OidcClient untyped)
    implements OidcClient {
  /// [OidcClient.signIn] with [provider]'s name.
  Future<OidcUser> signIn(
    P provider, {
    required BrowserLauncher launcher,
    required String redirectUri,
  }) => untyped.signIn(
    provider.providerName,
    launcher: launcher,
    redirectUri: redirectUri,
  );

  /// [OidcClient.signInRelay] with [provider]'s name.
  Future<OidcUser> signInRelay(
    P provider, {
    required BrowserLauncher launcher,
    required String relayTo,
  }) => untyped.signInRelay(
    provider.providerName,
    launcher: launcher,
    relayTo: relayTo,
  );

  /// [OidcClient.exchange] with [provider]'s name.
  Future<OidcUser> exchange({
    required String code,
    required String verifier,
    required String callbackUrl,
    required P provider,
    required String state,
    required String nonce,
    String? iss,
  }) => untyped.exchange(
    code: code,
    verifier: verifier,
    callbackUrl: callbackUrl,
    provider: provider.providerName,
    state: state,
    nonce: nonce,
    iss: iss,
  );
}
