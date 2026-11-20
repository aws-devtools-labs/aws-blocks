// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'blocks_exception.dart';
import 'client_lifetime.dart';
import 'default_session_store.dart';
import 'response_url.dart';
import 'rpc_user_agent_headers.dart';
import 'session_store.dart';
import 'token_store.dart';
import 'transport.dart';

/// JSON-RPC 2.0 HTTP client for CDK Blocks backends.
class BlocksClient {
  final String baseUrl;
  final http.Client _httpClient;

  /// Holds the session cookies the backend sets and sends them back on later
  /// calls.
  ///
  /// When the constructor is given none, this is the default store: in a
  /// Flutter app that depends on `blocks_runtime_flutter`, a store in the
  /// platform's secure storage, shared by every client, so a signed-in user
  /// stays signed in after the app restarts. Elsewhere it is a new
  /// [InMemorySessionStore] unless the program registered a store with
  /// [registerDefaultSessionStore]. Pass `InMemorySessionStore()` to keep this
  /// client's session in memory only.
  ///
  /// A [PersistentSessionStore] reads its storage before it answers the first
  /// call's cookies, so the session saved by an earlier run is sent on that
  /// call.
  final SessionStore sessionStore;
  final TokenStore tokenStore;

  /// Optional bearer token auth provider.
  ///
  /// When it has an access token, calls send it as an `Authorization: Bearer`
  /// header, alongside the session cookie when there is one. It used to
  /// replace the cookie; the server prefers the cookie when both are sent.
  AuthProvider? authProvider;

  int _nextId = 1;

  final ClientLifetime _lifetime = ClientLifetime();

  BlocksClient({
    required this.baseUrl,
    http.Client? client,
    SessionStore? sessionStore,
    TokenStore? tokenStore,
    this.authProvider,
  }) : _httpClient = client ?? http.Client(),
       sessionStore = sessionStore ?? defaultSessionStore(),
       tokenStore = tokenStore ?? InMemoryTokenStore();

  /// Calls a JSON-RPC method with the given params and returns the result.
  ///
  /// [params] is a `List` or a `Map`, sent as the request's `params` as is.
  /// A CDK Blocks server reads params by position: a list is the method's
  /// argument list, and a map is read by its values, in order, so a key left
  /// out moves every later value up a slot. Generated clients send a list, as
  /// the TypeScript client does: the arguments in the method's parameter
  /// order, `null` in the slot of a left-out optional that comes before a set
  /// one, and trailing left-out optionals omitted.
  ///
  /// The request is POSTed to `{baseUrl}/{namespace}` (e.g.
  /// `…/cdk-blocks/api/reports` for `reports.build`), so a namespace that runs
  /// on its own compute is served by it.
  ///
  /// Throws an [ArgumentError], before any request is sent, when [params] is
  /// neither a `List` nor a `Map`, and a [ClientClosedException] when this
  /// client has been closed.
  ///
  /// A method with no return value (`Promise<void>` on the backend) gets an
  /// envelope with no `result`, and returns null.
  ///
  /// Otherwise a failure throws a [BlocksException]:
  ///
  /// - An [ApiException] when the response carries a JSON-RPC error, at any
  ///   HTTP status. Its [ApiException.status] is the error's code, or 500
  ///   for a reserved JSON-RPC code; match on [ApiException.name] with
  ///   [isBlocksError].
  /// - A [TransportException] when no usable result came back: no response
  ///   at all (its `cause` is the HTTP client's error, such as a
  ///   `TimeoutException`), a non-2xx response with no JSON-RPC error, or a
  ///   body that is not a JSON-RPC envelope.
  Future<dynamic> call(String method, Object params) async {
    if (params is! List && params is! Map) {
      throw ArgumentError.value(
        params,
        'params',
        'must be a List (positional) or a Map',
      );
    }
    _ensureOpen();
    final response = await _doCall(method, params);

    if (response.response.statusCode == 401 && authProvider != null) {
      await authProvider!.onAuthFailure();
      _ensureOpen();
      final retry = await _doCall(method, params);
      return _parseResponse(retry);
    }

    return _parseResponse(response);
  }

  Future<ResponseWithUrl> _doCall(String method, Object params) async {
    final id = _nextId++;
    final body = jsonEncode({
      'jsonrpc': '2.0',
      'method': method,
      'params': params,
      'id': id,
    });

    final requestUri = _rpcUri(baseUrl, method);
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...rpcUserAgentHeaders(),
    };

    // The session cookie goes on every call that has one, and a bearer token
    // as well when the auth provider has one: the server prefers the cookie,
    // and some auth methods accept only the cookie.
    final cookie = await sessionStore.cookieHeaderFor(requestUri);
    if (cookie != null) {
      headers['cookie'] = cookie;
    }
    if (authProvider != null) {
      final token = await authProvider!.getAccessToken();
      if (token != null) {
        headers['authorization'] = 'Bearer $token';
      }
    }

    return guardRequest(
      () => postWithResponseUrl(
        _httpClient,
        requestUri,
        headers: headers,
        body: body,
      ),
    );
  }

  void _ensureOpen() {
    if (_lifetime.isClosed) throw const ClientClosedException();
  }

  /// The URL a call to [method] is POSTed to: `{baseUrl}/{namespace}`, where
  /// the namespace is the part of [method] before the first `.` — the path the
  /// TypeScript client uses, so the backend's gateway can route each namespace
  /// to the compute that hosts it. The body still carries the full
  /// `namespace.method`, which is what the server dispatches on. A [method]
  /// without a namespace goes to [baseUrl] unchanged.
  static Uri _rpcUri(String baseUrl, String method) {
    final dot = method.indexOf('.');
    if (dot <= 0) return Uri.parse(baseUrl);
    var end = baseUrl.length;
    while (end > 0 && baseUrl[end - 1] == '/') {
      end--;
    }
    final segment = Uri(pathSegments: [method.substring(0, dot)]).path;
    return Uri.parse('${baseUrl.substring(0, end)}/$segment');
  }

  dynamic _parseResponse(ResponseWithUrl result) {
    final response = result.response;
    // Parse set-cookie headers
    sessionStore.setCookies(
      response.headers['set-cookie'],
      requestUri: result.url,
    );

    final status = response.statusCode;
    Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      // Not JSON, or not text in the response's charset.
      decoded = null;
    }
    final json = decoded is Map<String, dynamic> ? decoded : null;

    // A JSON-RPC error is the server's answer whatever the HTTP status: a
    // namespace created with `httpErrorStatus: true` answers a 4xx with the
    // same envelope as the 200 it sends otherwise.
    final error = json?['error'];
    if (error is Map<String, dynamic>) {
      final code = error['code'];
      final message = error['message'];
      final data = error['data'];
      final name = data is Map<String, dynamic> ? data['name'] : null;
      throw ApiException(
        message is String ? message : 'Unknown error',
        status: rpcStatus(code),
        name: name is String ? name : reservedRpcErrorName(code),
        retriable: data is Map<String, dynamic> && data['retriable'] == true,
      );
    }

    if (status < 200 || status > 299) {
      // Not a JSON-RPC error: a gateway or route error such as
      // `{"error": "Not Found"}` or `{"message": "Forbidden"}`, or no JSON.
      throw TransportException(
        _bodyMessage(json) ?? 'HTTP $status',
        statusCode: status,
      );
    }
    if (json == null || json['jsonrpc'] != '2.0') {
      throw TransportException(
        'Response was not a JSON-RPC envelope',
        statusCode: status,
      );
    }
    if (error != null) {
      throw TransportException(
        'JSON-RPC error was not an object',
        statusCode: status,
      );
    }
    // An envelope with no `result` is a method with no return value: the
    // server leaves `result` out for `Promise<void>`.
    final value = json['result'];
    // An OIDC client hydrated from this result shares this client's closed
    // state. Skip the walk for a body that holds no descriptor.
    if (response.body.contains('oidc')) linkOidcDescriptors(value, _lifetime);
    return value;
  }

  /// The message a non-JSON-RPC error body carries: a string `error`, else a
  /// string `message`.
  static String? _bodyMessage(Map<String, dynamic>? json) {
    for (final key in const ['error', 'message']) {
      final value = json?[key];
      if (value is String && value.isNotEmpty) return value;
    }
    return null;
  }

  /// Closes the underlying HTTP client and frees resources.
  ///
  /// A [call] after this throws a [ClientClosedException] without sending
  /// anything, and so does every call of an `OidcClient` a generated client
  /// hydrated from one of this client's results, whose own HTTP client is
  /// closed too. Closing twice does nothing more.
  void close() {
    if (_lifetime.isClosed) return;
    _lifetime.close();
    _httpClient.close();
  }
}
