import 'package:http/http.dart' as http;

import 'user_agent.dart';

/// Sets [blocksUserAgentToken] as the User-Agent so AWS service telemetry
/// can attribute the request to this runtime.
class UserAgentClient extends http.BaseClient {
  final http.Client _inner;

  UserAgentClient(this._inner);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    request.headers['User-Agent'] = blocksUserAgentToken;
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}
