/// Sealed hierarchy of OIDC errors.
///
/// All OIDC failures are subclasses of [OidcException] so callers can switch
/// exhaustively over the failure modes.
sealed class OidcException implements Exception {
  final String message;
  final Object? cause;

  const OidcException(this.message, [this.cause]);

  @override
  String toString() => cause == null
      ? 'OidcException: $message'
      : 'OidcException: $message (cause: $cause)';
}

/// The requested provider name is not configured in the spec.
class OidcUnknownProviderException extends OidcException {
  final String provider;
  OidcUnknownProviderException(this.provider)
    : super('Provider not configured: $provider');
}

/// Token exchange with the backend failed.
class OidcExchangeException extends OidcException {
  OidcExchangeException(super.message, [super.cause]);
}

/// The redirect callback URI was malformed, carried an error, or the returned
/// state / CSRF value did not match (possible CSRF attack).
class OidcCallbackException extends OidcException {
  OidcCallbackException(super.message);
}

/// A request to one of the auth block's routes got a response the client
/// doesn't accept, such as a 5xx from the session or sign-out route.
class OidcRequestException extends OidcException {
  /// The HTTP status of the response.
  final int statusCode;

  /// The error name the server sent in its JSON body (`{"name": …}`), such
  /// as `SignOutIncompleteException`, or null when it sent none.
  final String? errorName;

  OidcRequestException(
    super.message, {
    required this.statusCode,
    this.errorName,
  });
}

/// The user dismissed / cancelled the sign-in flow.
class OidcCancelledException extends OidcException {
  OidcCancelledException() : super('Sign-in cancelled');
}
