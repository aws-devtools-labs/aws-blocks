import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'blocks_rpc_exception.dart';
import 'rpc_user_agent_headers.dart';
import 'session_store.dart';
import 'token_store.dart';

/// JSON-RPC 2.0 HTTP client for Blocks backends.
class BlocksClient {
  final String baseUrl;
  final http.Client _httpClient;
  final SessionStore sessionStore;
  final TokenStore tokenStore;

  /// Optional bearer token auth provider. Takes priority over cookie auth.
  AuthProvider? authProvider;

  int _nextId = 1;

  BlocksClient({
    required this.baseUrl,
    http.Client? client,
    SessionStore? sessionStore,
    TokenStore? tokenStore,
    this.authProvider,
  }) : _httpClient = client ?? http.Client(),
       sessionStore = sessionStore ?? InMemorySessionStore(),
       tokenStore = tokenStore ?? InMemoryTokenStore();

  /// Calls a JSON-RPC method with the given params and returns the result.
  ///
  /// The request is POSTed to `{baseUrl}/{namespace}` (e.g.
  /// `…/aws-blocks/api/reports` for `reports.build`), so a namespace that runs
  /// on its own compute is served by it.
  Future<dynamic> call(String method, Map<String, dynamic> params) async {
    final response = await _doCall(method, params);

    if (response.statusCode == 401 && authProvider != null) {
      await authProvider!.onAuthFailure();
      final retry = await _doCall(method, params);
      return _parseResponse(retry);
    }

    return _parseResponse(response);
  }

  Future<http.Response> _doCall(
    String method,
    Map<String, dynamic> params,
  ) async {
    final id = _nextId++;
    final body = jsonEncode({
      'jsonrpc': '2.0',
      'method': method,
      'params': params,
      'id': id,
    });

    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...rpcUserAgentHeaders(),
    };

    // Bearer token takes priority
    if (authProvider != null) {
      final token = await authProvider!.getAccessToken();
      if (token != null) {
        headers['authorization'] = 'Bearer $token';
      }
    } else {
      final cookie = sessionStore.cookieHeader;
      if (cookie != null) {
        headers['cookie'] = cookie;
      }
    }

    return _httpClient.post(
      _rpcUri(baseUrl, method),
      headers: headers,
      body: body,
    );
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

  dynamic _parseResponse(http.Response response) {
    // Parse set-cookie headers
    sessionStore.setCookies(response.headers['set-cookie']);

    final json = jsonDecode(response.body) as Map<String, dynamic>;
    if (json.containsKey('error')) {
      final error = json['error'] as Map<String, dynamic>;
      throw BlocksRpcException(
        code: error['code'] as int,
        message: error['message'] as String,
        data: error['data'],
      );
    }
    return json['result'];
  }

  /// Closes the underlying HTTP client and frees resources.
  void close() {
    _httpClient.close();
  }
}
