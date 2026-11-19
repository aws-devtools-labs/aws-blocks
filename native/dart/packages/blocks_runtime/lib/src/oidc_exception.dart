// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'blocks_exception.dart';

/// Sealed hierarchy of OIDC errors.
///
/// All OIDC failures are subclasses of [OidcException] so callers can switch
/// exhaustively over the failure modes.
///
/// These are the failures of the sign-in flow itself. An auth route that
/// refuses a request, such as a sign-out the server couldn't finish, throws
/// an [ApiException] carrying the server's status and error name, and one
/// that gets no usable response throws a [TransportException], as a JSON-RPC
/// call does.
sealed class OidcException extends BlocksException {
  const OidcException(super.message, [super.cause]);
}

/// The requested provider name is not configured in the spec.
class OidcUnknownProviderException extends OidcException {
  final String provider;
  OidcUnknownProviderException(this.provider)
    : super('Provider not configured: $provider');
}

/// Token exchange with the backend failed.
///
/// When the backend refused the code, [cause] is the [ApiException] with its
/// status and error name; when it answered with a body that is not a JSON
/// object, it is a [TransportException]. An exchange that got no response
/// throws a [TransportException] itself, as every call does.
class OidcExchangeException extends OidcException {
  OidcExchangeException(super.message, [super.cause]);
}

/// The redirect callback URI was malformed, carried an error, or the returned
/// state / CSRF value did not match (possible CSRF attack).
class OidcCallbackException extends OidcException {
  OidcCallbackException(super.message);
}

/// The user dismissed / cancelled the sign-in flow.
class OidcCancelledException extends OidcException {
  /// [message] says why, for example a desktop sign-in that timed out.
  OidcCancelledException([super.message = 'Sign-in cancelled']);
}
