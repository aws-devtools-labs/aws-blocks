@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/timeout_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  group('BlocksConfig', () {
    const config = BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api');

    test('compares by value', () {
      const same = BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api');
      expect(config, same);
      expect(config.hashCode, same.hashCode);
      expect(
        config,
        isNot(const BlocksConfig(baseUrl: 'https://b.example/aws-blocks/api')),
      );
    });

    test('copyWith replaces only the values it is given', () {
      expect(config.copyWith(), config);
      expect(
        config.copyWith(baseUrl: 'https://staging.example/aws-blocks/api'),
        const BlocksConfig(baseUrl: 'https://staging.example/aws-blocks/api'),
      );
    });

    test('toString names the base URL', () {
      expect(
        config.toString(),
        'BlocksConfig(baseUrl: https://a.example/aws-blocks/api)',
      );
    });
  });

  group('rewriteLocalhost', () {
    test('rewrites a localhost URL to the given host', () {
      expect(
        rewriteLocalhost(
          'http://localhost:3001/aws-blocks/api',
          host: '10.0.2.2',
        ),
        'http://10.0.2.2:3001/aws-blocks/api',
      );
      expect(
        rewriteLocalhost('https://a.example/aws-blocks/api', host: '10.0.2.2'),
        'https://a.example/aws-blocks/api',
      );
      expect(
        rewriteLocalhost('http://localhost:3001'),
        'http://localhost:3001',
      );
    });

    test('BlocksConfig.rewriteLocalhost still forwards to it', () {
      expect(
        // ignore: deprecated_member_use_from_same_package
        BlocksConfig.rewriteLocalhost(
          'ws://localhost:3001/realtime',
          host: '10.0.2.2',
        ),
        'ws://10.0.2.2:3001/realtime',
      );
      expect(
        // ignore: deprecated_member_use_from_same_package
        BlocksConfig.rewriteLocalhost('http://localhost:3001'),
        'http://localhost:3001',
      );
    });
  });

  group('BlocksClient.fromConfig', () {
    test('calls the config\'s baseUrl', () async {
      Uri? requested;
      final mock = MockClient((req) async {
        requested = req.url;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
          200,
        );
      });
      final client = BlocksClient.fromConfig(
        const BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api'),
        client: mock,
      );
      expect(await client.call('api.greet', const []), 'ok');
      expect(client.baseUrl, 'https://a.example/aws-blocks/api');
      expect(requested.toString(), 'https://a.example/aws-blocks/api/api');
    });

    test('keeps the stores it is given', () {
      final sessionStore = InMemorySessionStore();
      final tokenStore = InMemoryTokenStore();
      final client = BlocksClient.fromConfig(
        const BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api'),
        client: MockClient((_) async => http.Response('', 500)),
        sessionStore: sessionStore,
        tokenStore: tokenStore,
      );
      expect(client.sessionStore, same(sessionStore));
      expect(client.tokenStore, same(tokenStore));
    });

    test('uses the default timeout client', () async {
      // Accepts every request and never answers it.
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((_) {});
      addTearDown(() => server.close(force: true));
      const idle = Duration(milliseconds: 200);
      debugHttpTimeoutsOverride = (connect: idle * 2, idle: idle);
      addTearDown(() => debugHttpTimeoutsOverride = null);
      final client = BlocksClient.fromConfig(
        BlocksConfig(baseUrl: 'http://127.0.0.1:${server.port}/aws-blocks/api'),
      );
      addTearDown(client.close);
      await expectLater(
        client.call('api.greet', const []),
        throwsA(
          isA<TimeoutException>().having((e) => e.duration, 'duration', idle),
        ),
      );
    }, timeout: const Timeout(Duration(seconds: 10)));
  });
}
