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
  /// [params] is a `List` or a `Map`, sent as the request's `params` as is.
  /// An AWS Blocks server reads params by position: a list is the method's
  /// argument list, and a map is read by its values, in order, so a key left
  /// out moves every later value up a slot. Generated clients send a list, as
  /// the TypeScript client does: the arguments in the method's parameter
  /// order, `null` in the slot of a left-out optional that comes before a set
  /// one, and trailing left-out optionals omitted.
  ///
  /// Throws an [ArgumentError], before any request is sent, when [params] is
  /// neither a `List` nor a `Map`.
  Future<dynamic> call(String method, Object params) async {
    if (params is! List && params is! Map) {
      throw ArgumentError.value(
        params,
        'params',
        'must be a List (positional) or a Map',
      );
    }
    final response = await _doCall(method, params);

    if (response.statusCode == 401 && authProvider != null) {
      await authProvider!.onAuthFailure();
      final retry = await _doCall(method, params);
      return _parseResponse(retry);
    }

    return _parseResponse(response);
  }

  Future<http.Response> _doCall(String method, Object params) async {
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

    return _httpClient.post(Uri.parse(baseUrl), headers: headers, body: body);
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
