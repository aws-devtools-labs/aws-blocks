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
  });
}
