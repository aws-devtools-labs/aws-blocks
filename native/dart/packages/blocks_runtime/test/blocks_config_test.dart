@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  group('BlocksConfig', () {
    const config = BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api');

    test('defaults to a 30s connect and 60s idle timeout', () {
      expect(config.connectTimeout, const Duration(seconds: 30));
      expect(config.idleTimeout, const Duration(seconds: 60));
    });

    test('compares by value', () {
      const same = BlocksConfig(baseUrl: 'https://a.example/aws-blocks/api');
      expect(config, same);
      expect(config.hashCode, same.hashCode);
      expect(
        config,
        isNot(const BlocksConfig(baseUrl: 'https://b.example/aws-blocks/api')),
      );
      expect(
        config,
        isNot(
          const BlocksConfig(
            baseUrl: 'https://a.example/aws-blocks/api',
            connectTimeout: Duration(seconds: 5),
          ),
        ),
      );
      expect(
        config,
        isNot(
          const BlocksConfig(
            baseUrl: 'https://a.example/aws-blocks/api',
            idleTimeout: Duration(seconds: 5),
          ),
        ),
      );
    });

    test('copyWith replaces only the values it is given', () {
      expect(config.copyWith(), config);
      final staging = config.copyWith(
        baseUrl: 'https://staging.example/aws-blocks/api',
      );
      expect(staging.baseUrl, 'https://staging.example/aws-blocks/api');
      expect(staging.connectTimeout, config.connectTimeout);
      expect(staging.idleTimeout, config.idleTimeout);
      final slow = config.copyWith(
        connectTimeout: const Duration(seconds: 1),
        idleTimeout: const Duration(seconds: 2),
      );
      expect(slow.baseUrl, config.baseUrl);
      expect(slow.connectTimeout, const Duration(seconds: 1));
      expect(slow.idleTimeout, const Duration(seconds: 2));
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

    group('timeouts', () {
      late HttpServer server;
      late String baseUrl;

      setUp(() async {
        // Accepts every request and never answers it.
        server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        server.listen((_) {});
        baseUrl = 'http://127.0.0.1:${server.port}/aws-blocks/api';
      });

      tearDown(() => server.close(force: true));

      test('a call fails after the config\'s idle timeout', () async {
        final client = BlocksClient.fromConfig(
          BlocksConfig(
            baseUrl: baseUrl,
            idleTimeout: const Duration(milliseconds: 200),
          ),
        );
        addTearDown(client.close);
        final elapsed = Stopwatch()..start();
        await expectLater(
          client.call('api.greet', const []),
          throwsA(
            isA<TimeoutException>().having(
              (e) => e.duration,
              'duration',
              const Duration(milliseconds: 200),
            ),
          ),
        );
        expect(elapsed.elapsed, lessThan(const Duration(seconds: 5)));
      }, timeout: const Timeout(Duration(seconds: 10)));

      test('a connect fails after the config\'s connect timeout', () async {
        // TEST-NET-1 (RFC 5737) is not routed, so the connect never
        // completes. A network that rejects it outright fails fast instead.
        final client = BlocksClient.fromConfig(
          const BlocksConfig(
            baseUrl: 'http://192.0.2.1:81/aws-blocks/api',
            connectTimeout: Duration(milliseconds: 300),
          ),
        );
        addTearDown(client.close);
        try {
          await client.call('api.greet', const []);
          fail('expected the call to fail');
        } on TimeoutException catch (e) {
          expect(e.duration, const Duration(milliseconds: 300));
        } on http.ClientException catch (e) {
          markTestSkipped('the network rejected the address: $e');
        }
      }, timeout: const Timeout(Duration(seconds: 10)));
    });
  });
}
