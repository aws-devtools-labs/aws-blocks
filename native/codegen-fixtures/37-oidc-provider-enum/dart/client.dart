// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle, FileTransferException, RealtimeException, RealtimeChannelClosedException, RealtimeConnectionException, RealtimeSubscriptionEndedException, TransferableException, InvalidDescriptorException;
export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;
export 'package:blocks_runtime/blocks_runtime.dart' show TypedOidcClient, OidcProvider;

// --- Models ---

// --- API Namespaces ---

/// The providers `auth.getClient` signs in with.
enum AuthApiGetClientProvider implements OidcProvider {
  google('google'),
  github('github'),
  mySso('my-sso'),
  loginGov('login.gov')
;

  const AuthApiGetClientProvider(this.providerName);

  @override
  final String providerName;

  /// The provider whose `providerName` is [name], or null if no provider has that name.
  static AuthApiGetClientProvider? fromProviderName(String name) {
    for (final provider in values) {
      if (provider.providerName == name) return provider;
    }
    return null;
  }
}


class AuthApi {
  final BlocksClient _client;
  AuthApi(this._client);

  Future<TypedOidcClient<AuthApiGetClientProvider>> getClient() async {
    final result = await _client.call('auth.getClient', const <dynamic>[]);
    return TypedOidcClient<AuthApiGetClientProvider>(OidcClient.fromJson(result as Map<String, dynamic>, baseUrl: _client.baseUrl, tokenStore: _client.tokenStore, sessionStore: _client.sessionStore));
  }
}


class LegacyAuthApi {
  final BlocksClient _client;
  LegacyAuthApi(this._client);

  Future<OidcClient> getClient() async {
    final result = await _client.call('legacyAuth.getClient', const <dynamic>[]);
    return OidcClient.fromJson(result as Map<String, dynamic>, baseUrl: _client.baseUrl, tokenStore: _client.tokenStore, sessionStore: _client.sessionStore);
  }
}


// --- CDK Blocks Client ---

class Blocks {
  late final AuthApi auth;
  late final LegacyAuthApi legacyAuth;
  late final BlocksClient _client;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    _client = client;
    auth = AuthApi(client);
    legacyAuth = LegacyAuthApi(client);
  }

  /// Closes the client. A call after this throws a [ClientClosedException],
  /// and so does an `OidcClient` one of its calls returned. Closing twice
  /// does nothing more.
  void close() => _client.close();
}

