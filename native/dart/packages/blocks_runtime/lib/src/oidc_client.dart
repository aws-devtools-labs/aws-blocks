import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:blocks_runtime/src/transferable_descriptor.dart';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'browser_launcher.dart';
import 'oidc_auth_state.dart';
import 'oidc_exception.dart';
import 'oidc_types.dart';
import 'response_url.dart';
import 'session_store.dart';
import 'token_store.dart';

/// OIDC client implementing PKCE-based auth with token management.
///
/// [signInDirect], [signIn] and [exchange] take a provider by the name the
/// backend knows it by. A generated client whose spec names a method's
/// providers returns a `TypedOidcClient` instead, the same client with those
/// methods narrowed to an enum of that method's providers, so a provider the
/// client doesn't have is a compile error.
///
/// Hold one client per block for the app's lifetime: keep the client a
/// block's `getClient()` returns and use it for every sign-in, sign-out and
/// [restore], instead of calling `getClient()` again. Each client tracks its
/// own sign-in state, and only the requests of one client know to drop a
/// result a later sign-in or sign-out made stale.
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

  /// The name of the block's session cookie (`auth_<block id>` for an
  /// `Auth` block), which [signOut] removes when the server couldn't. Null
  /// when the descriptor doesn't send it, as an older backend's doesn't; the
  /// client then removes the cookies its own sign-in set.
  final String? sessionCookieName;

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

  /// Shared session store. In the cookie flow the session cookie set by the
  /// backend's `/exchange` response is captured here and replayed by the
  /// owning [BlocksClient] on subsequent JSON-RPC calls. Pass the
  /// `BlocksClient`'s own `sessionStore` instance so they share state.
  final SessionStore sessionStore;

  final http.Client _httpClient;

  /// Prepended to every [tokenStore] key. [fromJson] sets it to the
  /// directory of the descriptor's `exchangePath` followed by `/`, such as
  /// `/aws-blocks/auth/`, so the clients of several `Auth` blocks can share
  /// one token store. Empty for a client built with the constructor, which
  /// keeps the unprefixed keys.
  String _keyPrefix = '';

  /// The [tokenStore] key for [name].
  String _key(String name) => '$_keyPrefix$name';

  /// The token names an earlier version stored without a block prefix.
  static const _legacyTokenNames = [
    'access_token',
    'refresh_token',
    'expires_at',
    'provider',
  ];

  /// Completes once tokens an earlier version stored under the unprefixed
  /// keys have been moved to this client's keys. Every method that reads or
  /// writes [tokenStore] waits for it.
  late final Future<void> _ready = _migrateLegacyTokens();

  /// The exchange route of the `Auth` block version 0.2.0 stored the
  /// unprefixed tokens for.
  static const _legacyExchangePath = '/aws-blocks/auth/exchange';

  /// Moves tokens stored under the unprefixed keys, by version 0.2.0 or
  /// earlier, to this client's prefixed keys, so an upgrade doesn't sign a
  /// bearer session out. Version 0.2.0 only signed in against the default
  /// `Auth` block, so it moves them only into a [fromJson] client whose
  /// [exchangePath] is that block's, `/aws-blocks/auth/exchange`, and only
  /// when it has no tokens of its own yet, whatever other clients share
  /// [tokenStore] and in whatever order they are used. Otherwise it leaves
  /// them where they are.
  Future<void> _migrateLegacyTokens() async {
    if (_keyPrefix.isEmpty || exchangePath != _legacyExchangePath) return;
    for (final name in _legacyTokenNames) {
      if (await tokenStore.get(_key(name)) != null) return;
    }
    for (final name in _legacyTokenNames) {
      final value = await tokenStore.get(name);
      if (value == null) continue;
      await tokenStore.set(_key(name), value);
      await tokenStore.delete(name);
    }
  }

  final _controller = StreamController<OidcAuthState>.broadcast();

  /// Counts the sign-ins and sign-outs that changed this client's session.
  /// [exchange] and [signOut] increment it when they change it, and a
  /// request that started before (such as [restore]) applies its result only
  /// if it is unchanged, so a late result never undoes a newer sign-in or
  /// sign-out.
  int _generation = 0;

  /// The user of the current state, or null when it isn't signed in.
  OidcUser? get _currentUser => switch (_authState) {
    OidcSignedIn(:final user) => user,
    _ => null,
  };
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
    this.sessionCookieName,
    SessionStore? sessionStore,
    http.Client? httpClient,
  }) : sessionPath =
           sessionPath ??
           '${exchangePath.contains('/') ? exchangePath.substring(0, exchangePath.lastIndexOf('/')) : ''}/session',
       sessionStore = sessionStore ?? InMemorySessionStore(),
       _httpClient = httpClient ?? http.Client();

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

  /// The sign-in state, starting with the current [authState] and then each
  /// change, as Kotlin's `authState` flow does. Each listener gets the state
  /// current when it subscribes first, so a listener added after [restore]
  /// or a sign-in sees that state without waiting for the next change. The
  /// stream can be listened to more than once.
  Stream<OidcAuthState> get authStateChanges => Stream.multi((listener) {
    listener.add(_authState);
    final changes = _controller.stream.listen(
      listener.add,
      onError: listener.addError,
      onDone: listener.close,
    );
    listener
      ..onPause = changes.pause
      ..onResume = changes.resume
      ..onCancel = changes.cancel;
  });

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
  /// `redirect_uri`; [signIn] is the flow that works with them.
  ///
  /// Throws [OidcUnknownProviderException] when [providers] doesn't list
  /// [provider], or [providerConfigs] has no entry for it.
  ///
  /// Signing in with an `Auth` block uses [signIn].
  Future<OidcUser> signInDirect(
    String provider, {
    required BrowserLauncher launcher,
    required String redirectUri,
  }) async {
    await _ready;
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

    final Uri callbackUri;
    final String storedState;
    final String storedVerifier;
    final String storedNonce;
    try {
      callbackUri = await launcher.launch(
        authorizeUri,
        callbackScheme: Uri.parse(redirectUri).scheme,
      );

      final returnedState = callbackUri.queryParameters['state'];
      final state = await tokenStore.get(_key('oidc_state'));
      if (state == null || returnedState != state) {
        throw StateError('OIDC state mismatch: possible CSRF attack');
      }
      storedState = state;
      storedVerifier = (await tokenStore.get(_key('oidc_verifier')))!;
      storedNonce = (await tokenStore.get(_key('oidc_nonce')))!;
    } finally {
      // Whatever happened, this attempt's PKCE values are spent.
      await tokenStore.delete(_key('oidc_verifier'));
      await tokenStore.delete(_key('oidc_state'));
      await tokenStore.delete(_key('oidc_nonce'));
    }

    final error = callbackUri.queryParameters['error'];
    if (error != null) {
      throw OidcCallbackException(
        _idpError(error, callbackUri.queryParameters['error_description']),
      );
    }
    final code = callbackUri.queryParameters['code'];
    if (code == null) {
      throw OidcCallbackException("Callback URI missing 'code' parameter");
    }

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
  /// Unlike [signInDirect] (the direct custom-scheme flow), this path:
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
  ///
  /// Throws [OidcUnknownProviderException] when [providers] doesn't list
  /// [provider].
  Future<OidcUser> signIn(
    String provider, {
    required BrowserLauncher launcher,
    required String relayTo,
  }) async {
    await _ready;
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
    final authorizeUri = _buildRelayAuthorizeUrl(
      params,
      callbackUrl,
      challenge,
    );

    // Step 3: open the browser and wait for the relay custom-scheme redirect.
    final resultUri = await launcher.launch(
      authorizeUri,
      callbackScheme: Uri.parse(relayTo).scheme,
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
      throw OidcCallbackException(_idpError(error, qp['error_description']));
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

  /// The message for an IdP `error` in a callback, with its description
  /// when it has one.
  static String _idpError(String error, String? description) =>
      description == null || description.isEmpty
      ? 'IdP error: $error'
      : 'IdP error: $error: $description';

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
  /// user, at [exchangePath]. [signInDirect] and [signIn] call it; call it
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
    await _ready;
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

    _generation++;

    // Capture the session cookie set by the backend so the owning
    // BlocksClient replays it on subsequent JSON-RPC calls (cookie flow),
    // and remember its name so a failed sign-out can remove it.
    final before = sessionStore.cookies;
    sessionStore.setCookies(
      response.headers['set-cookie'],
      requestUri: responseUrl,
    );
    await _rememberSessionCookies(before);

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

  /// Exchanges the stored refresh token for a new access token.
  ///
  /// - 200: stores the new access token, its expiry and, when the response
  ///   has one, the rotated refresh token.
  /// - 400 or 401: the refresh token is no longer valid. Clears the stored
  ///   tokens and emits [OidcSignedOut].
  /// - Any other status throws an [OidcRequestException], and a transport
  ///   failure throws the HTTP client's error. Both keep the tokens and the
  ///   state, so a later call can try again.
  ///
  /// With no refresh token stored, emits [OidcSignedOut]. When a sign-in or
  /// sign-out finishes while the request is in flight, the response is
  /// ignored, so it never stores tokens after a sign-out or over a newer
  /// sign-in's.
  Future<void> refresh() async {
    await _ready;
    if (_refreshCompleter != null) {
      return _refreshCompleter!.future;
    }
    final completer = _refreshCompleter = Completer<void>();
    // Captured before the first await: a sign-in or sign-out that finishes
    // while the token is read, or while the request is in flight, makes this
    // refresh stale.
    final generation = _generation;
    try {
      final refreshToken = await tokenStore.get(_key('refresh_token'));
      if (generation != _generation) return;
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

      // A sign-in or sign-out finished meanwhile: its tokens are newer.
      if (generation != _generation) return;
      final status = response.statusCode;
      if (status == 400 || status == 401) {
        await _clearTokens();
        _emit(OidcSignedOut());
        return;
      }
      if (status != 200) {
        throw OidcRequestException(
          'Token refresh failed: HTTP $status',
          statusCode: status,
          errorName: _errorName(response),
        );
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
    } catch (e, stackTrace) {
      // The callers that joined this refresh fail with it too, instead of
      // going on with the expired token. `ignore` keeps the error from being
      // reported as unhandled when no caller joined.
      completer
        ..future.ignore()
        ..completeError(e, stackTrace);
      rethrow;
    } finally {
      if (!completer.isCompleted) completer.complete();
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
  /// Whatever the outcome, the client signs out locally: it clears this
  /// block's stored tokens, removes this block's session cookie and emits
  /// [OidcSignedOut]. Then:
  ///
  /// - 2xx: returns the `logoutUrl` the server sent.
  /// - 503 with `SignOutIncompleteException`: the server cleared the cookie
  ///   but couldn't remove its session. Throws an [OidcRequestException] with
  ///   that [OidcRequestException.errorName].
  /// - Any other status throws an [OidcRequestException], and a transport
  ///   failure or a cancelled request rethrows the HTTP client's error. The
  ///   server may still hold the session; signing in again replaces it.
  ///
  /// A [restore] or a token refresh still in flight when the sign-out
  /// finishes doesn't apply its result.
  ///
  /// The session store is never cleared, because it may hold the cookies of
  /// other `Auth` blocks on the same app. This block's session cookie is the
  /// one named [sessionCookieName]: the server's `Set-Cookie` removes it on a
  /// 2xx, and the client removes it itself otherwise. With a descriptor from
  /// an older backend, which doesn't send [sessionCookieName], the client
  /// removes the cookies its own sign-in set instead, so a session signed in
  /// before this version keeps its cookie after a failed sign-out.
  Future<Uri?> signOut() async {
    await _ready;
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
    } catch (e, stackTrace) {
      // A transport failure or a cancelled request.
      await _signOutLocally(url);
      Error.throwWithStackTrace(e, stackTrace);
    }
    sessionStore.setCookies(response.headers['set-cookie'], requestUri: url);
    await _signOutLocally(url);

    final status = response.statusCode;
    if (status >= 200 && status < 300) return _logoutUrl(response.body);
    final name = _errorName(response);
    if (status == 503 && name == 'SignOutIncompleteException') {
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

  /// The [tokenStore] key, under this block's prefix, of the names of the
  /// cookies this block's sign-in set.
  static const _sessionCookiesKey = 'session_cookies';

  /// The names of the cookies this block's sign-ins set.
  Future<Set<String>> _sessionCookieNames() async {
    final stored = await tokenStore.get(_key(_sessionCookiesKey));
    if (stored == null) return {};
    try {
      final json = jsonDecode(stored);
      return json is List ? json.whereType<String>().toSet() : {};
    } on FormatException {
      return {};
    }
  }

  /// Records the cookies a sign-in response set or changed in
  /// [sessionStore], compared with [before], as this block's.
  Future<void> _rememberSessionCookies(Map<String, String> before) async {
    if (sessionCookieName != null) return;
    final set = [
      for (final MapEntry(:key, :value) in sessionStore.cookies.entries)
        if (before[key] != value) key,
    ];
    if (set.isEmpty) return;
    final names = {...await _sessionCookieNames(), ...set}.toList()..sort();
    await tokenStore.set(_key(_sessionCookiesKey), jsonEncode(names));
  }

  /// Signs out locally after a sign-out request, whatever its outcome:
  /// removes this block's session cookie from [sessionStore] as a request to
  /// [url] would send it ([sessionCookieName], or else the cookies its
  /// sign-in set), clears its stored tokens and emits [OidcSignedOut].
  Future<void> _signOutLocally(Uri url) async {
    _generation++;
    final names = switch (sessionCookieName) {
      final name? => {name},
      null => await _sessionCookieNames(),
    };
    for (final name in names) {
      sessionStore.setCookies('$name=; Max-Age=0', requestUri: url);
    }
    await tokenStore.delete(_key(_sessionCookiesKey));
    await _clearTokens();
    _emit(OidcSignedOut());
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
  ///
  /// When a sign-in or sign-out finishes while the request is in flight,
  /// the response is ignored and [restore] returns the current state's user,
  /// or null, so a late answer never undoes the newer state.
  Future<OidcUser?> restore() async {
    await _ready;
    final generation = _generation;
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
    // A sign-in or sign-out finished while this was in flight: its state is
    // newer, so don't apply this response's cookies, user or sign-out.
    if (generation != _generation) return _currentUser;
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
    await _ready;
    final token = await tokenStore.get(_key('access_token'));
    if (token == null) return null;
    if (await _isExpired()) {
      await refresh();
      return tokenStore.get(_key('access_token'));
    }
    return token;
  }

  /// Refreshes the access token after the backend rejected a call. Signs out
  /// only when the refresh route rejects the refresh token (see [refresh]);
  /// any other refresh failure is rethrown, so the call fails with it.
  @override
  Future<void> onAuthFailure() async {
    await _ready;
    await refresh();
  }

  // --- Factory ---

  /// A client for the `{"__blocks": "oidc/client", …}` descriptor a block's
  /// `getClient()` returns. It stores its tokens and sign-in state under
  /// keys prefixed with the directory of the descriptor's `exchangePath`
  /// (such as `/aws-blocks/auth/access_token`), so the clients of several
  /// blocks can share one token store. Hold one client per block (see
  /// [OidcClient]).
  ///
  /// Only `exchangePath` is required: a descriptor without it, or with a
  /// non-string one, throws a [FormatException] naming the field. The session
  /// and refresh routes come from the descriptor's `sessionPath` and
  /// `refreshPath` when it sends them, and otherwise from the directory of
  /// `exchangePath`, as `Auth` mounts them; so do `signOutPath`,
  /// `callbackPath` and `authorizeParamsBasePath`. Missing `providers` or
  /// `providerConfigs` mean none, and a provider config without a `kind` gets
  /// an empty one. `sessionCookieName`, when sent, is the block's session
  /// cookie, which [signOut] removes when the server couldn't.
  static OidcClient fromJson(
    Map<String, dynamic> descriptor, {
    required String baseUrl,
    required TokenStore tokenStore,
    SessionStore? sessionStore,
    http.Client? httpClient,
  }) {
    // Every route is found from the exchange route, so without it the
    // client can't work. A field the runtime can derive or do without falls
    // back to the `Auth` block's own value instead of failing the call that
    // returned it. Missing provider configs only fail `signInDirect` for that
    // provider; `signIn` reads the provider's authorize params from the
    // server.
    final exchangePath = requireDescriptorField<String>(
      descriptor,
      'exchangePath',
      tag: 'oidc/client',
      subject: 'OidcClient',
    );
    final base = _directoryOf(exchangePath);
    final providers =
        (descriptor['providers'] as List<dynamic>?)?.cast<String>() ??
        const <String>[];
    final configsJson =
        descriptor['providerConfigs'] as Map<String, dynamic>? ?? const {};
    final providerConfigs = configsJson.map(
      (k, v) => MapEntry(k, ProviderConfig.fromJson(v as Map<String, dynamic>)),
    );
    return OidcClient(
      exchangePath: exchangePath,
      refreshPath:
          descriptor['refreshPath'] as String? ?? '$exchangePath/refresh',
      sessionPath: descriptor['sessionPath'] as String? ?? '$base/session',
      signOutPath: descriptor['signOutPath'] as String? ?? '$base/signout',
      sessionCookieName: switch (descriptor['sessionCookieName']) {
        final String name when name.isNotEmpty => name,
        _ => null,
      },
      authorizeParamsBasePath:
          descriptor['authorizeParamsBasePath'] as String? ??
          '$base/authorize-params',
      callbackPath: descriptor['callbackPath'] as String? ?? '$base/callback',
      providers: providers,
      providerConfigs: providerConfigs,
      baseUrl: baseUrl,
      tokenStore: tokenStore,
      sessionStore: sessionStore,
      httpClient: httpClient,
    ).._keyPrefix = '$base/';
  }

  /// [path] up to its last `/`, or `''` when it has none.
  static String _directoryOf(String path) {
    final slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.substring(0, slash);
  }

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
