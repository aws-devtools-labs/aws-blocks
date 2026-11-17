// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

  const OidcUser({
    required this.userId,
    required this.username,
    required this.groups,
  });

  factory OidcUser.fromJson(Map<String, dynamic> json) {
    return OidcUser(
      userId: json['userId'] as String,
      username: json['username'] as String,
      // The server-relay exchange returns `{userId, username}` only (no groups),
      // so tolerate a missing/absent groups field.
      groups: (json['groups'] as List<dynamic>?)?.cast<String>() ?? const [],
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
