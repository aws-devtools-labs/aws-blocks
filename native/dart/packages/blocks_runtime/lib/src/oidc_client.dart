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
  /// Defaults to the directory of [exchangePath] followed by `/session`, the
  /// route the auth block serves next to its exchange route
  /// (`/aws-blocks/auth/session` for `/aws-blocks/auth/exchange`). A custom
  /// block whose descriptor names its own [exchangePath] gets the session
  /// route beside it.
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

  /// Prepended to every [tokenStore] key. [OidcClient.forAuth] sets it to the
  /// block's base path followed by `/`, so clients of several `Auth` blocks
  /// can share one token store. Empty for other clients, which keep the
  /// unprefixed keys.
  String _keyPrefix = '';

  /// The [tokenStore] key for [name].
  String _key(String name) => '$_keyPrefix$name';

  final _controller = StreamController<OidcAuthState>.broadcast();
  OidcAuthState _authState = OidcLoading();
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
           '${exchangePath.contains('/') ? exchangePath.substring(0, exchangePath.lastIndexOf('/')) : ''}/session',
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
  /// [client]'s. The client stores its tokens and sign-in state under keys
  /// prefixed with that directory (such as `/aws-blocks/auth/access_token`),
  /// so clients for several blocks can share one token store.
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
    ).._keyPrefix = '$base/';
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

  /// The current sign-in state: the state most recently added to
  /// [authStateChanges], or [OidcLoading] before the first one. Reading it
  /// needs no subscription, so an app can check the state once, such as on
  /// launch after [restore].
  OidcAuthState get authState => _authState;

  /// Records [state] as [authState] and adds it to [authStateChanges].
  void _emit(OidcAuthState state) {
    _authState = state;
    _controller.add(state);
  }

  /// The provider id of an `Auth` sign-in action: `google` for an action
  /// named `signIn:google`, from `getAuthState()`. Null for any other action
  /// name, including `signIn` (email and password) and `signIn:` with no id.
  ///
  /// A native app signs in with that provider through [signInRelay] instead
  /// of opening the action's `url`, which starts a browser-cookie sign-in
  /// whose cookie never reaches the app:
  ///
  /// ```dart
  /// final id = OidcClient.providerIdOf(action.name);
  /// if (id != null) await oidc.signInRelay(id, launcher: launcher);
  /// ```
  static String? providerIdOf(String actionName) {
    const prefix = 'signIn:';
    if (!actionName.startsWith(prefix) || actionName.length == prefix.length) {
      return null;
    }
    return actionName.substring(prefix.length);
  }

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
  ///
  /// A client built with [OidcClient.forAuth] has no provider configs; use
  /// [signInRelay].
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

    await tokenStore.set(_key('oidc_verifier'), verifier);
    await tokenStore.set(_key('oidc_state'), state);
    await tokenStore.set(_key('oidc_nonce'), nonce);

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
    final storedState = await tokenStore.get(_key('oidc_state'));
    if (storedState == null || returnedState != storedState) {
      throw StateError('OIDC state mismatch: possible CSRF attack');
    }

    final code = callbackUri.queryParameters['code']!;
    final storedVerifier = (await tokenStore.get(_key('oidc_verifier')))!;
    final storedNonce = (await tokenStore.get(_key('oidc_nonce')))!;

    await tokenStore.delete(_key('oidc_verifier'));
    await tokenStore.delete(_key('oidc_state'));
    await tokenStore.delete(_key('oidc_nonce'));

    return exchange(
      code: code,
      verifier: storedVerifier,
      callbackUrl: redirectUri,
      provider: provider,
      state: storedState,
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

    // Step 4: validate the callback. The state and the CSRF value inside its
    // envelope are checked first, so a redirect that didn't come from this
    // sign-in can't report an IdP error either.
    final qp = resultUri.queryParameters;

    final returnedState = qp['state'];
    if (returnedState == null) {
      throw OidcCallbackException("Callback URI missing 'state' parameter");
    }
    if (returnedState != params.state) {
      throw OidcCallbackException('State mismatch in callback');
    }

    // Step 5: verify the CSRF value inside the state envelope.
    _verifyCsrf(returnedState, csrf);

    final error = qp['error'];
    if (error != null) {
      final description = qp['error_description'] ?? '';
      throw OidcCallbackException('IdP error: $error: $description');
    }

    final code = qp['code'];
    if (code == null) {
      throw OidcCallbackException("Callback URI missing 'code' parameter");
    }

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
  /// The request sends `tokens: false`: this client signs in with the
  /// session cookie, so the backend doesn't return bearer tokens even when
  /// it has them enabled.
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
        // The client signs in with the session cookie, so ask the backend
        // not to mint bearer tokens it would never use.
        'tokens': false,
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
      await tokenStore.set(_key('access_token'), json['accessToken'] as String);
      // Refresh must name the provider when the backend has several.
      await tokenStore.set(_key('provider'), provider);
    }
    if (json['refreshToken'] != null) {
      await tokenStore.set(
        _key('refresh_token'),
        json['refreshToken'] as String,
      );
    }
    await _storeExpiry(json);

    final userJson = json['user'];
    if (userJson == null) {
      throw OidcExchangeException("Exchange response missing 'user' field");
    }

    final user = OidcUser.fromJson(userJson as Map<String, dynamic>);
    _emit(OidcSignedIn(user));
    return user;
  }

  // --- Token refresh ---

  Future<void> refresh() async {
    if (_refreshCompleter != null) {
      return _refreshCompleter!.future;
    }
    _refreshCompleter = Completer<void>();
    try {
      final refreshToken = await tokenStore.get(_key('refresh_token'));
      if (refreshToken == null) {
        _emit(OidcSignedOut());
        return;
      }

      final provider = await tokenStore.get(_key('provider'));
      final response = await _httpClient.post(
        Uri.parse('$_authBaseUrl$refreshPath'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': refreshToken, 'provider': ?provider}),
      );

      if (response.statusCode != 200) {
        await _clearTokens();
        _emit(OidcSignedOut());
        return;
      }

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      await tokenStore.set(_key('access_token'), json['accessToken'] as String);
      await _storeExpiry(json);
      // The backend rotates the refresh token: the old one no longer works.
      if (json['refreshToken'] != null) {
        await tokenStore.set(
          _key('refresh_token'),
          json['refreshToken'] as String,
        );
      }
    } finally {
      _refreshCompleter!.complete();
      _refreshCompleter = null;
    }
  }

  // --- Sign out ---

  /// Signs out on the backend and locally, and returns the identity
  /// provider's logout URL, or null when the provider has none.
  ///
  /// POSTs `{signOutPath}?format=json` with the session cookie and an empty
  /// JSON body, which the server ignores. The app may open the returned
  /// URL with its launcher to end the identity provider's own session too;
  /// otherwise the next sign-in can complete without asking the user. This
  /// client doesn't open it.
  ///
  /// - 2xx: clears the stored tokens, emits [OidcSignedOut] and returns the
  ///   `logoutUrl` the server sent.
  /// - 503 with `SignOutIncompleteException`: the server cleared the cookie
  ///   but couldn't remove its session. Clears the stored tokens, emits
  ///   [OidcSignedOut], then throws an [OidcRequestException] with that
  ///   [OidcRequestException.errorName].
  /// - Any other status throws an [OidcRequestException], and a transport
  ///   failure throws the HTTP client's error. Both clear the stored tokens
  ///   but keep the session cookie and the state.
  ///
  /// The session store is never cleared, because it may hold the cookies of
  /// other `Auth` blocks on the same app. This block's cookie is removed by
  /// the `Set-Cookie` the server sends on the response.
  Future<Uri?> signOut() async {
    final url = Uri.parse('$_authBaseUrl$signOutPath?format=json');
    final http.Response response;
    try {
      // Carries the session cookie via _jsonHeaders so the backend can
      // invalidate the server-side session.
      response = await _httpClient.post(
        url,
        headers: _jsonHeaders(url),
        body: '{}',
      );
    } catch (_) {
      await _clearTokens();
      rethrow;
    }
    await _clearTokens();
    sessionStore.setCookies(response.headers['set-cookie'], requestUri: url);

    final status = response.statusCode;
    if (status >= 200 && status < 300) {
      _emit(OidcSignedOut());
      return _logoutUrl(response.body);
    }
    final name = _errorName(response);
    if (status == 503 && name == 'SignOutIncompleteException') {
      _emit(OidcSignedOut());
      throw OidcRequestException(
        'Signed out locally, but the backend could not remove its session',
        statusCode: status,
        errorName: name,
      );
    }
    throw OidcRequestException(
      'Sign-out failed: HTTP $status',
      statusCode: status,
      errorName: name,
    );
  }

  /// The `logoutUrl` of a sign-out response body, or null when it has none.
  static Uri? _logoutUrl(String body) {
    if (body.trim().isEmpty) return null;
    try {
      final json = jsonDecode(body);
      final url = json is Map<String, dynamic> ? json['logoutUrl'] : null;
      return url is String && url.isNotEmpty ? Uri.tryParse(url) : null;
    } on FormatException {
      return null;
    }
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
  /// `Authorization: Bearer` header when an unexpired access token is stored:
  ///
  /// - 200: emits [OidcSignedIn] with the server's user and returns it.
  /// - 401: clears the stored tokens, emits [OidcSignedOut] and returns null.
  /// - 404: the block serves no session route: an `Auth` block with no
  ///   sign-in providers, or a custom block that doesn't serve one. Throws an
  ///   [OidcRequestException] that says so.
  /// - A 200 whose body isn't a JSON object with a `user` the client can
  ///   read throws an [OidcRequestException] and leaves the state as is.
  /// - Any other status throws an [OidcRequestException], and a transport
  ///   failure throws the HTTP client's error. Neither changes the state.
  Future<OidcUser?> restore() async {
    final url = Uri.parse('$_authBaseUrl$sessionPath');
    final storedToken = await tokenStore.get(_key('access_token'));
    final accessToken = storedToken != null && !await _isExpired()
        ? storedToken
        : null;
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
        final Object? json;
        try {
          json = jsonDecode(response.body);
        } on FormatException {
          throw OidcRequestException(
            'Malformed session response: not JSON',
            statusCode: 200,
          );
        }
        final userJson = json is Map<String, dynamic> ? json['user'] : null;
        if (userJson is! Map<String, dynamic>) {
          throw OidcRequestException(
            "Session response missing 'user' field",
            statusCode: 200,
          );
        }
        final OidcUser user;
        try {
          user = OidcUser.fromJson(userJson);
          // A cast in fromJson fails with a TypeError on a field of the wrong
          // type; report it as the malformed response it is.
          // ignore: avoid_catching_errors
        } on TypeError {
          throw OidcRequestException(
            'Malformed session response: unreadable user',
            statusCode: 200,
          );
        }
        _emit(OidcSignedIn(user));
        return user;
      case 401:
        await _clearTokens();
        _emit(OidcSignedOut());
        return null;
      case 404:
        throw OidcRequestException(
          'GET $url returned 404: the block serves no session route. An '
          'Auth block with no sign-in providers has none, and a custom '
          'block has one only if it serves GET $sessionPath',
          statusCode: 404,
          errorName: _errorName(response),
        );
      default:
        throw OidcRequestException(
          'Session request failed: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
          errorName: _errorName(response),
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
    final token = await tokenStore.get(_key('access_token'));
    if (token == null) return null;
    if (await _isExpired()) {
      await refresh();
      return tokenStore.get(_key('access_token'));
    }
    return token;
  }

  @override
  Future<void> onAuthFailure() async {
    try {
      await refresh();
    } catch (_) {
      await _clearTokens();
      _emit(OidcSignedOut());
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
    final expiresAt = await tokenStore.get(_key('expires_at'));
    if (expiresAt == null) return true;
    final expiry = int.tryParse(expiresAt);
    if (expiry == null) return true;
    return DateTime.now().millisecondsSinceEpoch >= expiry;
  }

  /// Stores the access token's expiry, in epoch milliseconds, from a token
  /// response: `expiresIn` seconds from now, which the auth block sends, or
  /// an absolute `expiresAt` as a fallback.
  Future<void> _storeExpiry(Map<String, dynamic> json) async {
    final expiresIn = json['expiresIn'];
    if (expiresIn is num) {
      final expiresAt = DateTime.now()
          .add(Duration(seconds: expiresIn.toInt()))
          .millisecondsSinceEpoch;
      await tokenStore.set(_key('expires_at'), expiresAt.toString());
    } else if (json['expiresAt'] != null) {
      await tokenStore.set(_key('expires_at'), json['expiresAt'].toString());
    }
  }

  Future<void> _clearTokens() async {
    await tokenStore.delete(_key('access_token'));
    await tokenStore.delete(_key('refresh_token'));
    await tokenStore.delete(_key('expires_at'));
    await tokenStore.delete(_key('provider'));
  }
}
