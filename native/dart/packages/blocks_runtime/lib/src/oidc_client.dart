import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'blocks_client.dart';
import 'browser_launcher.dart';
import 'oidc_auth_state.dart';
import 'oidc_exception.dart';
import 'oidc_types.dart';
import 'response_url.dart';
import 'session_store.dart';
import 'token_store.dart';
import 'transferable_descriptor.dart';

/// OIDC client implementing PKCE-based auth with token management.
///
/// [signIn], [signInRelay] and [exchange] take a provider by the name the
/// backend knows it by. A generated client whose spec names a method's
/// providers returns a `TypedOidcClient` instead, the same client with those
/// methods narrowed to an enum of that method's providers, so a provider the
/// client doesn't have is a compile error.
class OidcClient implements AuthProvider {
  final String exchangePath;
  final String refreshPath;
  final String signOutPath;

  /// Base path for the server-relay authorize-params endpoint. The provider
  /// name is appended: `{authorizeParamsBasePath}/<provider>`.
  ///
  /// Defaults to [defaultAuthorizeParamsBasePath].
  final String authorizeParamsBasePath;

  /// The backend's HTTPS callback path registered as the IdP `redirect_uri`
  /// in the server-relay flow.
  ///
  /// Defaults to [defaultCallbackPath].
  final String callbackPath;

  /// The backend's session route, which [restore] reads.
  ///
  /// Defaults to the directory of [callbackPath] followed by `/session`, the
  /// route the auth block serves (`/aws-blocks/auth/session` for the default
  /// [callbackPath]).
  final String sessionPath;

  /// The auth block's default authorize-params route
  /// (`POST /aws-blocks/auth/authorize-params/<provider>`), used when neither
  /// the constructor nor the descriptor names one.
  static const String defaultAuthorizeParamsBasePath =
      '/aws-blocks/auth/authorize-params';

  /// The auth block's default callback route (`GET /aws-blocks/auth/callback`),
  /// used when neither the constructor nor the descriptor names one.
  static const String defaultCallbackPath = '/aws-blocks/auth/callback';

  final List<String> providers;
  final Map<String, ProviderConfig> providerConfigs;
  final String baseUrl;
  final TokenStore tokenStore;

  /// The custom-scheme URI [signInRelay] relays back to when its own
  /// `relayTo` is omitted, such as `myappscheme://oidcRedirect`. Set by
  /// [OidcClient.forAuth]; null when not configured.
  final String? relayTo;

  /// Shared session store. In the cookie flow the session cookie set by the
  /// backend's `/exchange` response is captured here and replayed by the
  /// owning [BlocksClient] on subsequent JSON-RPC calls. Pass the
  /// `BlocksClient`'s own `sessionStore` instance so they share state.
  final SessionStore sessionStore;

  final http.Client _httpClient;

  /// The descriptor [fromJson] hydrated this client from, unchanged, as
  /// [toJson] returns it. Null for a client built with the constructor.
  Map<String, dynamic>? _wireDescriptor;

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
    this.authorizeParamsBasePath = defaultAuthorizeParamsBasePath,
    this.callbackPath = defaultCallbackPath,
    String? sessionPath,
    this.relayTo,
    SessionStore? sessionStore,
    http.Client? httpClient,
  }) : sessionPath =
           sessionPath ??
           '${callbackPath.substring(0, callbackPath.lastIndexOf('/'))}/session',
       sessionStore = sessionStore ?? InMemorySessionStore(),
       _httpClient = httpClient ?? http.Client();

  /// The prefix every `Auth` route lives under.
  static const String _authRoutePrefix = '/aws-blocks/auth/';

  /// A client for an `Auth` block's federated sign-in, sharing [client]'s
  /// base URL, HTTP client and session store, so the session cookie the
  /// exchange sets is the one [client]'s calls send.
  ///
  /// [providers] are the ids of the block's sign-in providers that this
  /// client may sign in with; any other id throws
  /// [OidcUnknownProviderException] before a request is sent. [relayTo] is
  /// the custom-scheme URI the backend relays back to, which must be listed
  /// in the block's `redirects.allowedRelayOrigins`; [signInRelay] uses it
  /// when it isn't given one. [callbackPath] and [signOutPath] are the
  /// block's `redirects.callbackPath` and `redirects.signOutPath`; leave them
  /// at their defaults unless the block sets them. The other routes are
  /// derived from [callbackPath] the way the block derives them: its
  /// directory, followed by `/authorize-params/<id>`, `/exchange`,
  /// `/session` and `/exchange/refresh`. [tokenStore] defaults to
  /// [client]'s.
  ///
  /// It returns a plain [OidcClient]. An app that has an enum of the block's
  /// providers can wrap it as `TypedOidcClient<E>(client)`.
  ///
  /// ```dart
  /// final client = BlocksClient(baseUrl: 'https://api.example.com/aws-blocks/api');
  /// final oidc = OidcClient.forAuth(
  ///   client,
  ///   providers: ['google'],
  ///   relayTo: 'myapp://auth',
  /// );
  /// final user = await oidc.signInRelay('google', launcher: launcher);
  /// ```
  ///
  /// Makes no network call. Throws an [ArgumentError] when either path is
  /// not under `/aws-blocks/auth/`, or [callbackPath] has no segment after
  /// that prefix or ends with `/`.
  factory OidcClient.forAuth(
    BlocksClient client, {
    required List<String> providers,
    String? relayTo,
    String callbackPath = defaultCallbackPath,
    String signOutPath = '/aws-blocks/auth/signout',
    TokenStore? tokenStore,
  }) {
    if (!callbackPath.startsWith(_authRoutePrefix) ||
        callbackPath.length == _authRoutePrefix.length ||
        callbackPath.endsWith('/')) {
      throw ArgumentError.value(
        callbackPath,
        'callbackPath',
        "must be a path under '$_authRoutePrefix' with no trailing '/'",
      );
    }
    if (!signOutPath.startsWith(_authRoutePrefix)) {
      throw ArgumentError.value(
        signOutPath,
        'signOutPath',
        "must be a path under '$_authRoutePrefix'",
      );
    }
    final base = callbackPath.substring(0, callbackPath.lastIndexOf('/'));
    return OidcClient(
      exchangePath: '$base/exchange',
      refreshPath: '$base/exchange/refresh',
      signOutPath: signOutPath,
      authorizeParamsBasePath: '$base/authorize-params',
      callbackPath: callbackPath,
      sessionPath: '$base/session',
      providers: List.unmodifiable(providers),
      providerConfigs: const {},
      baseUrl: client.baseUrl,
      tokenStore: tokenStore ?? client.tokenStore,
      relayTo: relayTo == null || relayTo.isEmpty ? null : relayTo,
      sessionStore: client.sessionStore,
      httpClient: client.httpClient,
    );
  }

  /// API origin that the server-relay auth routes resolve against.
  ///
  /// [baseUrl] is the JSON-RPC endpoint (e.g.
  /// `https://host/prod/aws-blocks/api`), but the auth routes (`/auth/*`,
  /// `/auth-relay/*`, …) mount at the API *origin*, not under the RPC path. We
  /// strip the RPC prefix so auth requests target `<origin><authPath>` — the
  /// auth path prefix itself comes from the server-provided path fields
  /// (`authorizeParamsBasePath`, `exchangePath`, …).
  ///
  /// The cut is at the first path segment that is exactly `aws-blocks`:
  /// scheme, host, port and every segment before it (an API Gateway stage
  /// such as `/prod`) are kept, with no trailing `/`. So a URL that repeats
  /// the RPC prefix (`…/aws-blocks/api/aws-blocks/api`) gives the same origin
  /// as one that has it once. Falls back to [baseUrl] with its trailing `/`
  /// stripped when no segment is `aws-blocks` (e.g. a bare origin).
  String get _authBaseUrl {
    final uri = Uri.parse(baseUrl.trim());
    // Split the encoded path, so a percent-encoded stage stays as sent.
    final segments = uri.path.split('/');
    final cut = segments.indexOf('aws-blocks');
    var s = cut < 0
        ? baseUrl.trim()
        : '${uri.scheme}://${uri.authority}${segments.take(cut).join('/')}';
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
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

  /// Signs in with [provider] through the direct custom-scheme flow, with
  /// [redirectUri] as the IdP `redirect_uri`. Most IdPs reject a custom-scheme
  /// `redirect_uri`; [signInRelay] is the flow that works with them.
  ///
  /// Throws [OidcUnknownProviderException] when [providers] doesn't list
  /// [provider], or [providerConfigs] has no entry for it.
  Future<OidcUser> signIn(
    String provider, {
    required BrowserLauncher launcher,
    required String redirectUri,
  }) async {
    final config = providerConfigs[provider];
    if (!providers.contains(provider) || config == null) {
      throw OidcUnknownProviderException(provider);
    }

    final verifier = generateVerifier();
    final challenge = generateChallenge(verifier);
    final state = generateVerifier();
    final nonce = generateNonce();

    await tokenStore.set('oidc_verifier', verifier);
    await tokenStore.set('oidc_state', state);
    await tokenStore.set('oidc_nonce', nonce);

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
  /// `allowedRelayOrigins` (e.g. `myappscheme://oidcRedirect`). When it is
  /// omitted, the client's own [OidcClient.relayTo] is used.
  ///
  /// Throws [OidcUnknownProviderException] when [providers] doesn't list
  /// [provider]. Throws a [StateError] when neither [relayTo] nor the
  /// client's [OidcClient.relayTo] is set.
  Future<OidcUser> signInRelay(
    String provider, {
    required BrowserLauncher launcher,
    String? relayTo,
  }) async {
    if (!providers.contains(provider)) {
      throw OidcUnknownProviderException(provider);
    }
    final relay = (relayTo == null || relayTo.isEmpty) ? this.relayTo : relayTo;
    if (relay == null) {
      throw StateError(
        'signInRelay needs a relayTo: pass one to OidcClient.forAuth or to '
        'signInRelay. It must be listed in the backend\'s '
        'redirects.allowedRelayOrigins.',
      );
    }

    final csrf = generateRandom();
    final verifier = generateVerifier();
    final challenge = generateChallenge(verifier);

    // Step 1: fetch the signed state envelope from the backend.
    final params = await _fetchAuthorizeParams(provider, csrf, relay);

    // Step 2: build the authorize URL. redirect_uri = backend HTTPS callback.
    final callbackUrl = '$_authBaseUrl$callbackPath';
    final authorizeUri = _buildRelayAuthorizeUrl(
      params,
      callbackUrl,
      challenge,
    );

    // Step 3: open the browser and wait for the relay custom-scheme redirect.
    final resultUri = await launcher.launch(
      authorizeUri,
      callbackScheme: Uri.parse(relay).scheme,
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
    final url = Uri.parse(
      '$_authBaseUrl$authorizeParamsBasePath/${Uri.encodeComponent(provider)}',
    );
    final (:response, url: responseUrl) = await postWithResponseUrl(
      _httpClient,
      url,
      headers: _jsonHeaders(url),
      body: jsonEncode({'csrf': csrf, 'relayTo': relayTo}),
    );
    sessionStore.setCookies(
      response.headers['set-cookie'],
      requestUri: responseUrl,
    );

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

  /// Exchanges an authorization [code] from [provider] for the signed-in
  /// user, at [exchangePath]. [signIn] and [signInRelay] call it; call it
  /// directly only when the app ran the authorize step itself.
  ///
  /// Throws [OidcUnknownProviderException] when [providers] doesn't list
  /// [provider], before anything is sent.
  Future<OidcUser> exchange({
    required String code,
    required String verifier,
    required String callbackUrl,
    required String provider,
    required String state,
    required String nonce,
    String? iss,
  }) async {
    if (!providers.contains(provider)) {
      throw OidcUnknownProviderException(provider);
    }
    final url = Uri.parse('$_authBaseUrl$exchangePath');
    final (:response, url: responseUrl) = await postWithResponseUrl(
      _httpClient,
      url,
      headers: _jsonHeaders(url),
      body: jsonEncode({
        'code': code,
        'verifier': verifier,
        'callbackUrl': callbackUrl,
        'provider': provider,
        'state': state,
        'nonce': nonce,
        // RFC 9207 issuer forwarding — only sent when the relay callback
        // provided it.
        'iss': ?iss,
      }),
    );

    // Capture the session cookie set by the backend so the owning
    // BlocksClient replays it on subsequent JSON-RPC calls (cookie flow).
    sessionStore.setCookies(
      response.headers['set-cookie'],
      requestUri: responseUrl,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw OidcExchangeException(
        'Exchange failed: HTTP ${response.statusCode}',
      );
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
      final url = Uri.parse('$_authBaseUrl$signOutPath');
      await _httpClient.post(
        url,
        headers: _jsonHeaders(url),
        body: jsonEncode(
          refreshToken != null ? {'refreshToken': refreshToken} : {},
        ),
      );
    } catch (_) {
      // best-effort
    }
    await _clearTokens();
    sessionStore.clear();
    _controller.add(OidcSignedOut());
  }

  /// JSON content-type headers, plus the current session cookie when present so
  /// OIDC requests participate in the shared cookie session. Only cookies whose
  /// host, `Path` and `Secure` attributes match [url] are sent.
  Map<String, String> _jsonHeaders(Uri url) {
    final cookie = sessionStore.cookieHeaderFor(url);
    return {'Content-Type': 'application/json', 'cookie': ?cookie};
  }

  // --- Restore session ---

  /// Restores the signed-in user from the backend's session, as an app does
  /// on launch, and returns it, or null when there is no session.
  ///
  /// GETs [sessionPath] with the session cookie, plus an
  /// `Authorization: Bearer` header when an access token is stored:
  ///
  /// - 200: emits [OidcSignedIn] with the server's user and returns it.
  /// - 401: clears the stored tokens, emits [OidcSignedOut] and returns null.
  /// - 404: the block serves no session route, because it has no sign-in
  ///   providers. Throws an [OidcRequestException] that says so.
  /// - Any other status throws an [OidcRequestException], and a transport
  ///   failure throws the HTTP client's error. Neither changes the state.
  Future<OidcUser?> restore() async {
    final url = Uri.parse('$_authBaseUrl$sessionPath');
    final accessToken = await tokenStore.get('access_token');
    final cookie = sessionStore.cookieHeaderFor(url);
    final response = await _httpClient.get(
      url,
      headers: {
        'cookie': ?cookie,
        if (accessToken != null) 'authorization': 'Bearer $accessToken',
      },
    );
    sessionStore.setCookies(response.headers['set-cookie'], requestUri: url);

    switch (response.statusCode) {
      case 200:
        final json = jsonDecode(response.body);
        final userJson = json is Map<String, dynamic> ? json['user'] : null;
        if (userJson is! Map<String, dynamic>) {
          throw OidcRequestException(
            "Session response missing 'user' field",
            statusCode: 200,
          );
        }
        final user = OidcUser.fromJson(userJson);
        _controller.add(OidcSignedIn(user));
        return user;
      case 401:
        await _clearTokens();
        _controller.add(OidcSignedOut());
        return null;
      case 404:
        throw OidcRequestException(
          'GET $url returned 404: the auth block serves no session route, '
          'which means it has no sign-in providers',
          statusCode: 404,
          name: _errorName(response),
        );
      default:
        throw OidcRequestException(
          'Session request failed: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
          name: _errorName(response),
        );
    }
  }

  /// The error name a JSON error body carries (`{"name": …}`), if any.
  static String? _errorName(http.Response response) {
    try {
      final json = jsonDecode(response.body);
      final name = json is Map<String, dynamic> ? json['name'] : null;
      return name is String ? name : null;
    } on FormatException {
      return null;
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
      refreshPath:
          descriptor['refreshPath'] as String? ??
          '${descriptor['exchangePath'] as String}/refresh',
      signOutPath: descriptor['signOutPath'] as String,
      authorizeParamsBasePath:
          descriptor['authorizeParamsBasePath'] as String? ??
          defaultAuthorizeParamsBasePath,
      callbackPath:
          descriptor['callbackPath'] as String? ?? defaultCallbackPath,
      providers: providers,
      providerConfigs: providerConfigs,
      baseUrl: baseUrl,
      tokenStore: tokenStore,
      sessionStore: sessionStore,
      httpClient: httpClient,
    ).._wireDescriptor = descriptor;
  }

  /// This client's `{"__blocks": "oidc/client", …}` descriptor: the one
  /// [fromJson] hydrated it from, unchanged (keys this runtime doesn't read
  /// included), or, for a client built with the constructor, its providers
  /// and paths, in the shape [fromJson] reads. A generated client sends an
  /// OIDC client parameter, or one inside a model it sends, this way;
  /// `jsonEncode` calls it too. The base URL and the token and session stores
  /// are this app's, not the server's, so they aren't part of it.
  ///
  /// Returns a copy, so changing it doesn't change this client.
  Map<String, dynamic> toJson() => transferableDescriptor(
    'oidc/client',
    _wireDescriptor ??
        {
          'providers': providers,
          'providerConfigs': {
            for (final e in providerConfigs.entries)
              e.key: {
                'authorizeUrl': e.value.authorizeUrl,
                'clientId': e.value.clientId,
                'scopes': e.value.scopes,
                'kind': e.value.kind,
              },
          },
          'exchangePath': exchangePath,
          'refreshPath': refreshPath,
          'signOutPath': signOutPath,
          'authorizeParamsBasePath': authorizeParamsBasePath,
          'callbackPath': callbackPath,
        },
  );

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
