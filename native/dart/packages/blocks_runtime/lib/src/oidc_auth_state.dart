/// Authentication state for OIDC flows.
sealed class OidcAuthState {}

class OidcLoading extends OidcAuthState {}

class OidcSignedOut extends OidcAuthState {}

class OidcSignedIn extends OidcAuthState {
  final OidcUser user;
  OidcSignedIn(this.user);
}

/// Authenticated user info returned from token exchange.
class OidcUser {
  final String userId;
  final String username;
  final List<String> groups;

  /// The name to show for the user, as the server computes it. Null when the
  /// server didn't send it.
  final String? displayName;

  /// The user pool `sub`, or `<issuer>:<sub>` for a directly federated user.
  /// Null when the server didn't send it.
  final String? userSub;

  /// The id of the provider the user signed in with, or `password` for email
  /// and password sign-in. Null when the server didn't send it.
  final String? signInProvider;

  /// The user's attributes, keyed by attribute name. Null when the server
  /// didn't send them.
  final Map<String, String>? attributes;

  const OidcUser({
    required this.userId,
    required this.username,
    required this.groups,
    this.displayName,
    this.userSub,
    this.signInProvider,
    this.attributes,
  });

  factory OidcUser.fromJson(Map<String, dynamic> json) {
    return OidcUser(
      userId: json['userId'] as String,
      username: json['username'] as String,
      // The server-relay exchange returns `{userId, username}` only (no groups),
      // so tolerate a missing/absent groups field.
      groups: (json['groups'] as List<dynamic>?)?.cast<String>() ?? const [],
      displayName: json['displayName'] as String?,
      userSub: json['userSub'] as String?,
      signInProvider: json['signInProvider'] as String?,
      attributes: (json['attributes'] as Map<String, dynamic>?)?.map(
        (k, v) => MapEntry(k, v as String),
      ),
    );
  }
}

/// Configuration for an OIDC identity provider.
class ProviderConfig {
  final String authorizeUrl;
  final String clientId;
  final List<String> scopes;
  final String kind;

  const ProviderConfig({
    required this.authorizeUrl,
    required this.clientId,
    required this.scopes,
    required this.kind,
  });

  factory ProviderConfig.fromJson(Map<String, dynamic> json) {
    return ProviderConfig(
      authorizeUrl: json['authorizeUrl'] as String,
      clientId: json['clientId'] as String,
      scopes: (json['scopes'] as List<dynamic>).cast<String>(),
      kind: json['kind'] as String,
    );
  }
}
