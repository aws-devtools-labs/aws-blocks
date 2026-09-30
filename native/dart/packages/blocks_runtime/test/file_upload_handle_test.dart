@TestOn('vm')
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/user_agent.dart';
import 'package:test/test.dart';

void main() {
  group('FileUploadHandle', () {
    test('sends the user-agent token on the upload request', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      String? userAgent;
      server.listen((req) async {
        userAgent = req.headers.value('user-agent');
        await req.drain<void>();
        req.response.statusCode = 200;
        await req.response.close();
      });
      addTearDown(() => server.close(force: true));

      await FileUploadHandle.fromJson({
        'url': 'http://127.0.0.1:${server.port}/put',
      }).upload(Uint8List.fromList([1, 2, 3]));

      expect(userAgent, blocksUserAgentToken);
    });
  });
}
