import 'dart:convert';

import 'oidc_exception.dart';

/// Response from `POST {authorizeParamsBasePath}/<provider>` in the server-relay
/// flow. The backend generates and signs the [state] envelope; the client never
/// constructs `state` itself.
///
/// Matches the backend's authorize-params response shape.
class AuthorizeParamsResponse {
  final String authorizeUrl;
  final String clientId;
  final List<String> scopes;
  final String kind;

  /// Server-signed state envelope (`base64url(payload).base64url(hmac)`).
  final String state;

  /// OIDC nonce, present for OIDC providers.
  final String? nonce;

  const AuthorizeParamsResponse({
    required this.authorizeUrl,
    required this.clientId,
    required this.scopes,
    required this.kind,
    required this.state,
    this.nonce,
  });

  factory AuthorizeParamsResponse.fromJson(Map<String, dynamic> json) {
    return AuthorizeParamsResponse(
      authorizeUrl: json['authorizeUrl'] as String,
      clientId: json['clientId'] as String,
      scopes: (json['scopes'] as List<dynamic>).cast<String>(),
      kind: json['kind'] as String,
      state: json['state'] as String,
      nonce: json['nonce'] as String?,
    );
  }
}

/// Decoded payload of the signed `state` envelope.
///
/// Wire format (see `packages/bb-auth-oidc/src/state.ts`):
/// `base64url(JSON(payload)) + '.' + base64url(hmac-sha256(body))`, no padding.
///
/// The client only decodes and reads the payload portion to verify [csrf]; it
/// does NOT verify the HMAC signature (it has no signing secret — that is the
/// backend's responsibility). Matches the server-signed state envelope's
/// payload shape (csrf/relay/app).
class StatePayload {
  final int v;
  final String csrf;
  final String? relay;
  final String? app;

  const StatePayload({
    required this.v,
    required this.csrf,
    this.relay,
    this.app,
  });

  factory StatePayload.fromJson(Map<String, dynamic> json) {
    return StatePayload(
      v: (json['v'] as num).toInt(),
      csrf: json['csrf'] as String,
      relay: json['relay'] as String?,
      app: json['app'] as String?,
    );
  }

  /// Decode a signed state envelope's payload portion (the part before the
  /// first `.`). Throws [OidcCallbackException] if the envelope is malformed.
  ///
  /// Note: this only decodes the payload — it intentionally does not verify the
  /// HMAC signature, matching the Kotlin SDK behaviour.
  static StatePayload decodeEnvelope(String envelope) {
    final dotIdx = envelope.indexOf('.');
    // The payload is everything before the first '.'. A leading '.' (empty
    // payload) is malformed.
    final encodedPayload = dotIdx <= 0 ? '' : envelope.substring(0, dotIdx);
    if (encodedPayload.isEmpty) {
      throw OidcCallbackException('Malformed state envelope');
    }
    try {
      // Backend emits base64url without padding; Dart requires padding.
      final jsonStr = utf8.decode(
        base64Url.decode(base64Url.normalize(encodedPayload)),
      );
      final decoded = jsonDecode(jsonStr);
      if (decoded is! Map<String, dynamic>) {
        throw OidcCallbackException('Malformed state envelope payload');
      }
      return StatePayload.fromJson(decoded);
    } on OidcCallbackException {
      rethrow;
    } catch (e) {
      throw OidcCallbackException('Failed to decode state envelope: $e');
    }
  }
}
