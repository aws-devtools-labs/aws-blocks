@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' show ClientException;
import 'package:test/test.dart';

void main() {
  group('BlocksClient.close', () {
    test('a call after close fails at once and sends nothing', () async {
      var requests = 0;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        requests++;
        req.response.write('{"jsonrpc":"2.0","result":1,"id":1}');
        await req.response.close();
      });
      addTearDown(() => server.close(force: true));
      final client = BlocksClient(
        baseUrl: 'http://127.0.0.1:${server.port}/aws-blocks/api',
      );
      expect(await client.call('api.ping', []), 1);

      client.close();

      await expectLater(
        client.call('api.ping', []),
        throwsA(
          isA<ClientException>().having(
            (e) => e.message,
            'message',
            contains('Client is already closed'),
          ),
        ),
      );
      expect(requests, 1);
    });

    test('closing twice is not an error', () {
      BlocksClient(baseUrl: 'http://127.0.0.1:1/aws-blocks/api')
        ..close()
        ..close();
    });
  });
}
