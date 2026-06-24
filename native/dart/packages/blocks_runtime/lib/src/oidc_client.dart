import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'browser_launcher.dart';
import 'oidc_auth_state.dart';
import 'oidc_exception.dart';
import 'oidc_types.dart';
import 'session_store.dart';
import 'token_store.dart';

/// OIDC client implementing PKCE-based auth with token management.
class OidcClient implements AuthProvider {
  final String exchangePath;
  final String refreshPath;
  final String signOutPath;

  /// Base path for the server-relay authorize-params endpoint. The provider
  /// name is appended: `{authorizeParamsBasePath}/<provider>`.
  final String authorizeParamsBasePath;

  /// The backend's HTTPS callback path registered as the IdP `redirect_uri`
  /// in the server-relay flow.
  final String callbackPath;

  final List<String> providers;
  final Map<String, ProviderConfig> providerConfigs;
  final String baseUrl;
  final TokenStore tokenStore;

  /// Shared session store. In the cookie flow the session cookie set by the
  /// backend's `/exchange` response is captured here and replayed by the
  /// owning [BlocksClient] on subsequent JSON-RPC calls. Pass the
  /// `BlocksClient`'s own `sessionStore` instance so they share state.
  final SessionStore sessionStore;

  final http.Client _httpClient;

  final _controller = StreamController<OidcAuthState>.broadcast();
  Completer<void>? _refreshCompleter;

  OidcClient({
    required this.exchangePath,
    required this.refreshPath,
    required this.signOutPath,
    required this.providers,
    required this.providerConfigs,
    required this.baseUrl,
    required this.tokenStore,
    this.authorizeParamsBasePath = '/auth/authorize-params',
    this.callbackPath = '/auth/callback',
    SessionStore? sessionStore,
    http.Client? httpClient,
  })  : sessionStore = sessionStore ?? InMemorySessionStore(),
        _httpClient = httpClient ?? http.Client();

  /// The framework's JSON-RPC mount prefix. Auth routes do NOT live under it.
  static const String _rpcPathPrefix = '/aws-blocks/api';

  /// API origin that the server-relay auth routes resolve against.
  ///
  /// [baseUrl] is the JSON-RPC endpoint (e.g.
  /// `https://host/prod/aws-blocks/api`), but the auth routes (`/auth/*`,
  /// `/auth-relay/*`, …) mount at the API *origin*, not under the RPC path. We
  /// strip the RPC prefix so auth requests target `<origin><authPath>` — the
  /// auth path prefix itself comes from the server-provided path fields
  /// (`authorizeParamsBasePath`, `exchangePath`, …). Falls back to [baseUrl]
  /// unchanged when it doesn't end with the RPC prefix (e.g. a bare origin).
  String get _authBaseUrl {
    var s = baseUrl;
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    if (s.endsWith(_rpcPathPrefix)) {
      return s.substring(0, s.length - _rpcPathPrefix.length);
    }
    return s;
  }

  Stream<OidcAuthState> get authStateChanges => _controller.stream;

  // --- PKCE ---

  static String generateVerifier() {
    final random = Random.secure();
    final bytes = List<int>.generate(32, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }

  /// Generates a random base64url token (32 bytes → 43 chars, no padding).
  /// Used for the CSRF binding value in the server-relay flow.
  static String generateRandom() => generateVerifier();

  static String generateNonce() {
    final random = Random.secure();
    final bytes = List<int>.generate(32, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }

  static String generateChallenge(String verifier) {
    final bytes = utf8.encode(verifier);
    final digest = sha256.convert(bytes);
    return base64Url.encode(digest.bytes).replaceAll('=', '');
  }

  // --- Sign in (requires BrowserLauncher) ---

  Future<OidcUser> signIn(
    String provider, {
    required BrowserLauncher launcher,
    required String redirectUri,
  }) async {
    final verifier = generateVerifier();
    final challenge = generateChallenge(verifier);
    final state = generateVerifier();
    final nonce = generateNonce();

    await tokenStore.set('oidc_verifier', verifier);
    await tokenStore.set('oidc_state', state);
    await tokenStore.set('oidc_nonce', nonce);

    final config = providerConfigs[provider]!;
    final authorizeUri = Uri.parse(config.authorizeUrl).replace(
      queryParameters: {
        'client_id': config.clientId,
        'redirect_uri': redirectUri,
        'response_type': 'code',
        'scope': config.scopes.join(' '),
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'state': state,
        'nonce': nonce,
      },
    );

    final callbackUri = await launcher.launch(
      authorizeUri,
      callbackScheme: Uri.parse(redirectUri).scheme,
    );

    final returnedState = callbackUri.queryParameters['state'];
    final storedState = await tokenStore.get('oidc_state');
    if (returnedState != storedState) {
      throw StateError('OIDC state mismatch — possible CSRF attack');
    }

    final code = callbackUri.queryParameters['code']!;
    final storedVerifier = (await tokenStore.get('oidc_verifier'))!;
    final storedNonce = (await tokenStore.get('oidc_nonce'))!;

    await tokenStore.delete('oidc_verifier');
    await tokenStore.delete('oidc_state');
    await tokenStore.delete('oidc_nonce');

    return exchange(
      code: code,
      verifier: storedVerifier,
      callbackUrl: redirectUri,
      provider: provider,
      state: storedState!,
      nonce: storedNonce,
    );
  }

  // --- Server-relay sign in (matches Kotlin PR 477) ---

  /// Server-relay sign-in flow (aligns with the Kotlin Android SDK).
  ///
  /// Unlike [signIn] (the direct custom-scheme flow), this path:
  /// 1. POSTs to `{authorizeParamsBasePath}/<provider>` with a locally
  ///    generated CSRF value and [relayTo], receiving a server-signed `state`
  ///    envelope.
  /// 2. Builds the authorize URL using the backend's HTTPS [callbackPath] as
  ///    the IdP `redirect_uri` (real IdPs like Google reject custom-scheme
  ///    redirect URIs).
  /// 3. Launches the browser; the IdP redirects to the backend callback, which
  ///    relays back to the app via the [relayTo] custom-scheme URI.
  /// 4. Verifies the returned state matches and the CSRF inside the envelope.
  /// 5. Exchanges the code (forwarding `iss` per RFC 9207).
  ///
  /// [relayTo] must be the custom-scheme URI registered in the backend's
  /// `allowedRelayOrigins` (e.g. `myappscheme://oidcRedirect`).
  Future<OidcUser> signInRelay(
    String provider, {
    required BrowserLauncher launcher,
    required String relayTo,
  }) async {
    if (!providers.contains(provider)) {
      throw OidcUnknownProviderException(provider);
    }

    final csrf = generateRandom();
    final verifier = generateVerifier();
    final challenge = generateChallenge(verifier);

    // Step 1: fetch the signed state envelope from the backend.
    final params = await _fetchAuthorizeParams(provider, csrf, relayTo);

    // Step 2: build the authorize URL. redirect_uri = backend HTTPS callback.
    final callbackUrl = '$_authBaseUrl$callbackPath';
    final authorizeUri =
        _buildRelayAuthorizeUrl(params, callbackUrl, challenge);

    // Step 3: open the browser and wait for the relay custom-scheme redirect.
    final resultUri = await launcher.launch(
      authorizeUri,
      callbackScheme: Uri.parse(relayTo).scheme,
    );

    // Step 4: validate the callback.
    final qp = resultUri.queryParameters;

    final error = qp['error'];
    if (error != null) {
      final description = qp['error_description'] ?? '';
      throw OidcCallbackException('IdP error: $error — $description');
    }

    final code = qp['code'];
    if (code == null) {
      throw OidcCallbackException("Callback URI missing 'code' parameter");
    }
    final returnedState = qp['state'];
    if (returnedState == null) {
      throw OidcCallbackException("Callback URI missing 'state' parameter");
    }
    if (returnedState != params.state) {
      throw OidcCallbackException('State mismatch in callback');
    }

    // Step 5: verify the CSRF value inside the state envelope.
    _verifyCsrf(returnedState, csrf);

    // Step 6: exchange the code for the user (forwarding iss per RFC 9207).
    return exchange(
      code: code,
      verifier: verifier,
      callbackUrl: callbackUrl,
      provider: provider,
      state: params.state,
      nonce: params.nonce ?? '',
      iss: qp['iss'],
    );
  }

  Future<AuthorizeParamsResponse> _fetchAuthorizeParams(
    String provider,
    String csrf,
    String relayTo,
  ) async {
    final url =
        '$_authBaseUrl$authorizeParamsBasePath/${Uri.encodeComponent(provider)}';
    final response = await _httpClient.post(
      Uri.parse(url),
      headers: _jsonHeaders(),
      body: jsonEncode({'csrf': csrf, 'relayTo': relayTo}),
    );
    sessionStore.setCookies(response.headers['set-cookie']);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw OidcCallbackException(
        'Failed to fetch authorize params: HTTP ${response.statusCode} — ${response.body}',
      );
    }

    return AuthorizeParamsResponse.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Uri _buildRelayAuthorizeUrl(
    AuthorizeParamsResponse params,
    String redirectUri,
    String challenge,
  ) {
    final base = Uri.parse(params.authorizeUrl);
    return base.replace(
      queryParameters: {
        ...base.queryParameters,
        'response_type': 'code',
        'client_id': params.clientId,
        'redirect_uri': redirectUri,
        'scope': params.scopes.join(' '),
        'state': params.state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        if (params.nonce != null) 'nonce': params.nonce!,
      },
    );
  }

  /// Decodes the signed state envelope's payload and confirms the embedded CSRF
  /// matches [expectedCsrf]. Throws [OidcCallbackException] on mismatch.
  void _verifyCsrf(String state, String expectedCsrf) {
    final payload = StatePayload.decodeEnvelope(state);
    if (payload.csrf != expectedCsrf) {
      throw OidcCallbackException('CSRF mismatch in state envelope');
    }
  }

  // --- Token exchange ---

  Future<OidcUser> exchange({
    required String code,
    required String verifier,
    required String callbackUrl,
    required String provider,
    required String state,
    required String nonce,
    String? iss,
  }) async {
    final response = await _httpClient.post(
      Uri.parse('$_authBaseUrl$exchangePath'),
      headers: _jsonHeaders(),
      body: jsonEncode({
        'code': code,
        'verifier': verifier,
        'callbackUrl': callbackUrl,
        'provider': provider,
        'state': state,
        'nonce': nonce,
        // RFC 9207 issuer forwarding — only sent when the relay callback
        // provided it.
        if (iss != null) 'iss': iss,
      }),
    );

    // Capture the session cookie set by the backend so the owning
    // BlocksClient replays it on subsequent JSON-RPC calls (cookie flow).
    sessionStore.setCookies(response.headers['set-cookie']);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw OidcExchangeException(
          'Exchange failed: HTTP ${response.statusCode}');
    }

    final json = jsonDecode(response.body) as Map<String, dynamic>;

    // Bearer tokens are only present when the backend has `allowBearerAuth`
    // enabled. The default (cookie) flow returns just `{user}`, so store tokens
    // only when they exist.
    if (json['accessToken'] != null) {
      await tokenStore.set('access_token', json['accessToken'] as String);
    }
    if (json['refreshToken'] != null) {
      await tokenStore.set('refresh_token', json['refreshToken'] as String);
    }
    if (json['expiresAt'] != null) {
      await tokenStore.set('expires_at', json['expiresAt'].toString());
    } else if (json['expiresIn'] != null) {
      // Relay exchange (Kotlin parity) reports lifetime in seconds.
      final expiresAt = DateTime.now()
          .add(Duration(seconds: (json['expiresIn'] as num).toInt()))
          .millisecondsSinceEpoch;
      await tokenStore.set('expires_at', expiresAt.toString());
    }

    final userJson = json['user'];
    if (userJson == null) {
      throw OidcExchangeException("Exchange response missing 'user' field");
    }

    final user = OidcUser.fromJson(userJson as Map<String, dynamic>);
    _controller.add(OidcSignedIn(user));
    return user;
  }

  // --- Token refresh ---

  Future<void> refresh() async {
    if (_refreshCompleter != null) {
      return _refreshCompleter!.future;
    }
    _refreshCompleter = Completer<void>();
    try {
      final refreshToken = await tokenStore.get('refresh_token');
      if (refreshToken == null) {
        _controller.add(OidcSignedOut());
        return;
      }

      final response = await _httpClient.post(
        Uri.parse('$_authBaseUrl$refreshPath'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': refreshToken}),
      );

      if (response.statusCode != 200) {
        await _clearTokens();
        _controller.add(OidcSignedOut());
        return;
      }

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      await tokenStore.set('access_token', json['accessToken'] as String);
      await tokenStore.set('expires_at', json['expiresAt'].toString());
      if (json.containsKey('refreshToken')) {
        await tokenStore.set('refresh_token', json['refreshToken'] as String);
      }
    } finally {
      _refreshCompleter!.complete();
      _refreshCompleter = null;
    }
  }

  // --- Sign out ---

  Future<void> signOut() async {
    final refreshToken = await tokenStore.get('refresh_token');
    try {
      // Carries the session cookie via _jsonHeaders so the backend can
      // invalidate the server-side session (cookie flow). Bearer flow sends
      // the refresh token. Status/errors are ignored — local sign-out always
      // proceeds (matches Kotlin).
      await _httpClient.post(
        Uri.parse('$_authBaseUrl$signOutPath'),
        headers: _jsonHeaders(),
        body: jsonEncode(
            refreshToken != null ? {'refreshToken': refreshToken} : {}),
      );
    } catch (_) {
      // best-effort
    }
    await _clearTokens();
    sessionStore.clear();
    _controller.add(OidcSignedOut());
  }

  /// JSON content-type headers, plus the current session cookie when present so
  /// OIDC requests participate in the shared cookie session.
  Map<String, String> _jsonHeaders() {
    final cookie = sessionStore.cookieHeader;
    return {
      'Content-Type': 'application/json',
      if (cookie != null) 'cookie': cookie,
    };
  }

  // --- Restore session ---

  Future<void> restore() async {
    _controller.add(OidcLoading());
    final accessToken = await tokenStore.get('access_token');
    final refreshToken = await tokenStore.get('refresh_token');

    if (accessToken == null || refreshToken == null) {
      _controller.add(OidcSignedOut());
      return;
    }

    if (await _isExpired()) {
      try {
        await refresh();
      } catch (_) {
        await _clearTokens();
        _controller.add(OidcSignedOut());
        return;
      }
    }

    // Decode user from access token (JWT payload)
    final parts = (await tokenStore.get('access_token'))!.split('.');
    if (parts.length == 3) {
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      ) as Map<String, dynamic>;
      final user = OidcUser(
        userId: payload['sub'] as String? ?? '',
        username: payload['username'] as String? ?? '',
        groups: (payload['groups'] as List<dynamic>?)?.cast<String>() ?? [],
      );
      _controller.add(OidcSignedIn(user));
    } else {
      _controller.add(OidcSignedOut());
    }
  }

  // --- AuthProvider implementation ---

  @override
  Future<String?> getAccessToken() async {
    final token = await tokenStore.get('access_token');
    if (token == null) return null;
    if (await _isExpired()) {
      await refresh();
      return tokenStore.get('access_token');
    }
    return token;
  }

  @override
  Future<void> onAuthFailure() async {
    try {
      await refresh();
    } catch (_) {
      await _clearTokens();
      _controller.add(OidcSignedOut());
    }
  }

  // --- Factory ---

  static OidcClient fromJson(
    Map<String, dynamic> descriptor, {
    required String baseUrl,
    required TokenStore tokenStore,
    SessionStore? sessionStore,
    http.Client? httpClient,
  }) {
    final providers = (descriptor['providers'] as List<dynamic>).cast<String>();
    final configsJson = descriptor['providerConfigs'] as Map<String, dynamic>;
    final providerConfigs = configsJson.map(
      (k, v) => MapEntry(k, ProviderConfig.fromJson(v as Map<String, dynamic>)),
    );
    return OidcClient(
      exchangePath: descriptor['exchangePath'] as String,
      refreshPath: descriptor['refreshPath'] as String? ??
          '${descriptor['exchangePath'] as String}/refresh',
      signOutPath: descriptor['signOutPath'] as String,
      authorizeParamsBasePath:
          descriptor['authorizeParamsBasePath'] as String? ??
              '/auth/authorize-params',
      callbackPath: descriptor['callbackPath'] as String? ?? '/auth/callback',
      providers: providers,
      providerConfigs: providerConfigs,
      baseUrl: baseUrl,
      tokenStore: tokenStore,
      sessionStore: sessionStore,
      httpClient: httpClient,
    );
  }

  // --- Private helpers ---

  Future<bool> _isExpired() async {
    final expiresAt = await tokenStore.get('expires_at');
    if (expiresAt == null) return true;
    final expiry = int.tryParse(expiresAt);
    if (expiry == null) return true;
    return DateTime.now().millisecondsSinceEpoch >= expiry;
  }

  Future<void> _clearTokens() async {
    await tokenStore.delete('access_token');
    await tokenStore.delete('refresh_token');
    await tokenStore.delete('expires_at');
  }
}
