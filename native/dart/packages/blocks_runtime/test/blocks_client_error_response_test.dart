@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// Calls a method on a local server that answers every request with
/// [statusCode], [body] and [contentType].
Future<dynamic> _callAgainst(
  int statusCode,
  String body, {
  String contentType = 'application/json',
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    await request.drain<void>();
    request.response
      ..statusCode = statusCode
      ..headers.set('content-type', contentType)
      ..write(body);
    await request.response.close();
  });
  final client = BlocksClient(
    baseUrl: 'http://${server.address.host}:${server.port}/aws-blocks/api',
  );
  try {
    return await client.call('ns.method', []);
  } finally {
    client.close();
    await server.close(force: true);
  }
}

Matcher _notJsonRpc(int statusCode) => throwsA(
  isA<FormatException>().having(
    (e) => e.message,
    'message',
    'HTTP $statusCode: not a JSON-RPC response',
  ),
);

void main() {
  group('BlocksClient response that is not JSON-RPC', () {
    test('404 with a string error throws an Exception', () async {
      await expectLater(
        _callAgainst(404, '{"error":"Not Found"}'),
        throwsA(isA<Exception>()),
      );
      await expectLater(
        _callAgainst(404, '{"error":"Not Found"}'),
        _notJsonRpc(404),
      );
    });

    test('403 gateway message throws instead of returning null', () async {
      await expectLater(
        _callAgainst(403, '{"message":"Forbidden"}'),
        throwsA(isA<Exception>()),
      );
      await expectLater(
        _callAgainst(403, '{"message":"Forbidden"}'),
        _notJsonRpc(403),
      );
    });

    test('502 HTML body throws a FormatException with the status', () async {
      await expectLater(
        _callAgainst(
          502,
          '<html><body>Bad Gateway</body></html>',
          contentType: 'text/html',
        ),
        _notJsonRpc(502),
      );
    });

    test('200 with a JSON array throws an Exception', () async {
      await expectLater(_callAgainst(200, '[1]'), throwsA(isA<Exception>()));
      await expectLater(_callAgainst(200, '[1]'), _notJsonRpc(200));
    });

    test('error object with a non-int code is a BlocksRpcException', () async {
      await expectLater(
        _callAgainst(
          400,
          '{"jsonrpc":"2.0","id":1,"error":{"code":"E1","message":"Bad"}}',
        ),
        throwsA(
          isA<BlocksRpcException>()
              .having((e) => e.code, 'code', -1)
              .having((e) => e.message, 'message', 'Bad'),
        ),
      );
    });

    test('2xx response without result returns null', () async {
      expect(await _callAgainst(200, '{"jsonrpc":"2.0","id":1}'), isNull);
    });

    test('JSON-RPC error still throws BlocksRpcException', () async {
      await expectLater(
        _callAgainst(
          200,
          '{"jsonrpc":"2.0","id":1,'
          '"error":{"code":-32000,"message":"Boom","data":{"k":"v"}}}',
        ),
        throwsA(
          isA<BlocksRpcException>()
              .having((e) => e.code, 'code', -32000)
              .having((e) => e.message, 'message', 'Boom')
              .having((e) => e.data, 'data', {'k': 'v'}),
        ),
      );
    });
  });
}
