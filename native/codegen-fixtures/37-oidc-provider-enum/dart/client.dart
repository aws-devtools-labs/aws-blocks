// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;
export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;

// --- Models ---

// --- API Namespaces ---

class AuthApi {
  final BlocksClient _client;
  AuthApi(this._client);

  Future<OidcClient> getClient() async {
    final result = await _client.call('auth.getClient', <String, dynamic>{});
    return OidcClient.fromJson(result as Map<String, dynamic>, baseUrl: _client.baseUrl, tokenStore: _client.tokenStore, sessionStore: _client.sessionStore);
  }
}


class LegacyAuthApi {
  final BlocksClient _client;
  LegacyAuthApi(this._client);

  Future<OidcClient> getClient() async {
    final result = await _client.call('legacyAuth.getClient', <String, dynamic>{});
    return OidcClient.fromJson(result as Map<String, dynamic>, baseUrl: _client.baseUrl, tokenStore: _client.tokenStore, sessionStore: _client.sessionStore);
  }
}


// --- Blocks Client ---

class Blocks {
  late final AuthApi auth;
  late final LegacyAuthApi legacyAuth;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    auth = AuthApi(client);
    legacyAuth = LegacyAuthApi(client);
  }
}

