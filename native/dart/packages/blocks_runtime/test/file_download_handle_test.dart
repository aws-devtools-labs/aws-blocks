@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/user_agent.dart';
import 'package:test/test.dart';

void main() {
  group('FileDownloadHandle', () {
    test('sends the user-agent token on the download request', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      String? userAgent;
      server.listen((req) async {
        userAgent = req.headers.value('user-agent');
        req.response.statusCode = 200;
        await req.response.close();
      });
      addTearDown(() => server.close(force: true));

      await FileDownloadHandle.fromJson({
        'url': 'http://127.0.0.1:${server.port}/get',
      }).download();

      expect(userAgent, blocksUserAgentToken);
    });

    test('throws a FileTransferException with the HTTP status', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        req.response.statusCode = 404;
        await req.response.close();
      });
      addTearDown(() => server.close(force: true));

      await expectLater(
        FileDownloadHandle.fromJson({
          'url': 'http://127.0.0.1:${server.port}/get',
        }).download(),
        throwsA(
          isA<FileTransferException>()
              .having((e) => e.statusCode, 'statusCode', 404)
              .having((e) => e.message, 'message', 'Download failed: HTTP 404'),
        ),
      );
    });
  });
}
