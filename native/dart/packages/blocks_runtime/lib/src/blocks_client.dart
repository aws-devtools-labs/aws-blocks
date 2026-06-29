import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_provider.dart';
import 'blocks_rpc_exception.dart';
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
  })  : _httpClient = client ?? http.Client(),
        sessionStore = sessionStore ?? InMemorySessionStore(),
        tokenStore = tokenStore ?? InMemoryTokenStore();

  /// Calls a JSON-RPC method with the given params and returns the result.
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
      String method, Map<String, dynamic> params) async {
    final id = _nextId++;
    final body = jsonEncode({
      'jsonrpc': '2.0',
      'method': method,
      'params': params,
      'id': id,
    });

    final headers = <String, String>{
      'Content-Type': 'application/json',
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
      Uri.parse(baseUrl),
      headers: headers,
      body: body,
    );
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
