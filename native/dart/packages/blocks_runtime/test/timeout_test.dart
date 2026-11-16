@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/timeout_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Ends a red run (no timeout in the runtime) instead of hanging.
const _testTimeout = Timeout(Duration(seconds: 10));

const _idle = Duration(milliseconds: 300);

/// A server that accepts each request and never answers it.
Future<HttpServer> _silentServer() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final held = <HttpRequest>[];
  server.listen(held.add);
  addTearDown(() => server.close(force: true));
  return server;
}

/// A server that sends the status line, headers and a first body chunk, then
/// stops sending.
Future<HttpServer> _stallingBodyServer() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    await req.drain<void>();
    req.response
      ..bufferOutput = false
      ..statusCode = 200
      ..headers.contentType = ContentType.json
      ..contentLength = 100
      ..write('{"jsonrpc":"2.0",');
    await req.response.flush();
  });
  addTearDown(() => server.close(force: true));
  return server;
}

String _url(HttpServer server, [String path = '/']) =>
    'http://127.0.0.1:${server.port}$path';

OidcClient _oidcClient(String baseUrl, TokenStore store) => OidcClient(
  exchangePath: '/aws-blocks/auth/exchange',
  refreshPath: '/aws-blocks/auth/refresh',
  signOutPath: '/aws-blocks/auth/signout',
  providers: const ['google'],
  providerConfigs: const {},
  baseUrl: baseUrl,
  tokenStore: store,
);

final _throwsTimeout = throwsA(isA<TimeoutException>());

void main() {
  setUp(() {
    debugHttpTimeoutsOverride = (
      connect: const Duration(seconds: 2),
      idle: _idle,
    );
  });
  tearDown(() => debugHttpTimeoutsOverride = null);

  group('default clients time out', () {
    for (final (name, start) in [
      ('with no response', _silentServer),
      ('when the body stalls', _stallingBodyServer),
    ]) {
      group(name, () {
        test('RPC call', timeout: _testTimeout, () async {
          final server = await start();
          final client = BlocksClient(baseUrl: _url(server, '/aws-blocks/api'));
          addTearDown(client.close);
          await expectLater(client.call('api.ping', const []), _throwsTimeout);
        });

        test('OIDC refresh', timeout: _testTimeout, () async {
          final server = await start();
          final store = InMemoryTokenStore();
          await store.set('refresh_token', 'rt');
          final oidc = _oidcClient(_url(server, '/aws-blocks/api'), store);
          await expectLater(oidc.refresh(), _throwsTimeout);
        });

        test(
          'OIDC sign-out still signs out locally',
          timeout: _testTimeout,
          () async {
            final server = await start();
            final store = InMemoryTokenStore();
            await store.set('refresh_token', 'rt');
            await store.set('access_token', 'at');
            final oidc = _oidcClient(_url(server, '/aws-blocks/api'), store);
            await oidc.signOut();
            expect(await store.get('access_token'), isNull);
            expect(await store.get('refresh_token'), isNull);
          },
        );

        test('file upload', timeout: _testTimeout, () async {
          final server = await start();
          final handle = FileUploadHandle.fromJson({'url': _url(server)});
          await expectLater(
            handle.upload(Uint8List.fromList([1, 2, 3])),
            _throwsTimeout,
          );
        });

        test('file download', timeout: _testTimeout, () async {
          final server = await start();
          final handle = FileDownloadHandle.fromJson({'url': _url(server)});
          await expectLater(handle.download(), _throwsTimeout);
        });
      });
    }

    test(
      'a download that keeps sending is not cut off',
      timeout: _testTimeout,
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        server.listen((req) async {
          req.response
            ..bufferOutput = false
            ..statusCode = 200
            ..contentLength = 10;
          // One byte every 100ms: a second in total, over three idle windows.
          for (var i = 0; i < 10; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 100));
            req.response.add([i]);
            await req.response.flush();
          }
          await req.response.close();
        });

        final bytes = await FileDownloadHandle.fromJson({
          'url': _url(server),
        }).download();
        expect(bytes, List.generate(10, (i) => i));
      },
    );

    for (final (name, url, secret) in [
      ('user info', 'http://user:pw@127.0.0.1:PORT/key', 'pw'),
      ('fragment', 'http://127.0.0.1:PORT/key#frag-secret', 'frag-secret'),
    ]) {
      test(
        'the timeout message leaves out the $name',
        timeout: _testTimeout,
        () async {
          final server = await _silentServer();
          final handle = FileDownloadHandle.fromJson({
            'url': url.replaceFirst('PORT', '${server.port}'),
          });
          await expectLater(
            handle.download(),
            throwsA(
              isA<TimeoutException>()
                  .having((e) => e.message, 'message', contains('/key'))
                  .having((e) => e.message, 'message', isNot(contains(secret))),
            ),
          );
        },
      );
    }

    test(
      'the timeout message leaves out the query',
      timeout: _testTimeout,
      () async {
        final server = await _silentServer();
        final handle = FileDownloadHandle.fromJson({
          'url': '${_url(server, '/key')}?X-Amz-Signature=secret',
        });
        await expectLater(
          handle.download(),
          throwsA(
            isA<TimeoutException>()
                .having((e) => e.message, 'message', contains('/key'))
                .having((e) => e.message, 'message', isNot(contains('secret'))),
          ),
        );
      },
    );

    test(
      'connecting to an unreachable address times out',
      timeout: _testTimeout,
      () async {
        debugHttpTimeoutsOverride = (
          connect: const Duration(milliseconds: 500),
          idle: _idle,
        );
        // TEST-NET-1 (RFC 5737) is not routed, so the connect never completes.
        // A network that rejects it outright fails fast with another error.
        final client = BlocksClient(baseUrl: 'http://192.0.2.1:81/api');
        addTearDown(client.close);
        try {
          await client.call('api.ping', const []);
          fail('expected the call to fail');
        } on TimeoutException catch (e) {
          expect(e.message, startsWith('Connecting to'));
        } on http.ClientException catch (e) {
          markTestSkipped('the network rejected the address: $e');
        }
      },
    );

    test(
      'an upload through a runWithClient client that never answers times out',
      timeout: _testTimeout,
      () async {
        // Over one 64 KiB slice. Such a client reads the whole body before
        // sending, so the headers deadline is the idle timeout plus the time
        // to send the body at the minimum rate (about 4 seconds here).
        final body = Uint8List(65 * 1024);
        var read = 0;
        final fake = _FakeClient((request) async {
          await for (final chunk in request.finalize()) {
            read += chunk.length;
          }
          return Completer<Never>().future;
        });
        await expectLater(
          http.runWithClient(
            () => FileUploadHandle.fromJson({
              'url': 'http://example.test/up',
            }).upload(body),
            () => fake,
          ),
          _throwsTimeout,
        );
        expect(read, body.length);
      },
    );

    test('a caller-supplied client is used as is', () async {
      final client = BlocksClient(
        baseUrl: 'http://127.0.0.1/api',
        client: MockClient((_) async {
          await Future<void>.delayed(_idle * 2);
          return http.Response('{"jsonrpc":"2.0","id":1,"result":7}', 200);
        }),
      );
      expect(await client.call('api.ping', const []), 7);
    });
  });

  group('TimeoutClient', () {
    TimeoutClient wrap(http.Client inner, {bool streamsBody = false}) =>
        TimeoutClient(
          inner,
          connectTimeout: _idle * 2,
          idleTimeout: _idle,
          streamsRequestBody: streamsBody,
        );

    test(
      'a connect that never finishes times out with the connect timeout',
      timeout: _testTimeout,
      () async {
        final client = wrap(_FakeClient((_) => Completer<Never>().future));
        await expectLater(
          client.get(Uri.parse('http://example.test/')),
          throwsA(
            isA<TimeoutException>()
                .having((e) => e.duration, 'duration', _idle * 2)
                .having((e) => e.message, 'message', startsWith('Connecting')),
          ),
        );
      },
    );

    test(
      'a request whose finalize throws leaves no timer behind',
      timeout: _testTimeout,
      () async {
        final stray = <Object>[];
        await runZonedGuarded(() async {
          final client = wrap(_FakeClient((_) => Completer<Never>().future));
          await expectLater(
            () => client.send(_UnfinalizableRequest()),
            throwsStateError,
          );
          // Past the connect timeout, where a leftover timer would fire.
          await Future<void>.delayed(_idle * 4);
        }, (error, _) => stray.add(error));
        expect(stray, isEmpty);
      },
    );

    test('aborts the request on timeout', timeout: _testTimeout, () async {
      late http.BaseRequest seen;
      final client = wrap(
        _FakeClient((request) {
          seen = request;
          return Completer<Never>().future;
        }),
      );
      await expectLater(
        client.get(Uri.parse('http://example.test/')),
        _throwsTimeout,
      );
      final trigger = (seen as http.Abortable).abortTrigger!;
      await expectLater(trigger, completes);
    });

    test(
      'an upload the transport keeps taking is not cut off',
      timeout: _testTimeout,
      () async {
        // 640 KiB goes out as ten 64 KiB slices, one taken every 100ms: a
        // second in total, over three idle windows.
        final client = wrap(
          _FakeClient((request) async {
            var received = 0;
            await for (final chunk in request.finalize()) {
              received += chunk.length;
              await Future<void>.delayed(const Duration(milliseconds: 100));
            }
            return http.StreamedResponse(
              Stream.value('$received'.codeUnits),
              200,
              request: request,
            );
          }),
          streamsBody: true,
        );
        final response = await client.put(
          Uri.parse('http://example.test/'),
          body: Uint8List(640 * 1024),
        );
        expect(response.body, '${640 * 1024}');
      },
    );

    test(
      'an upload the transport stops taking times out',
      timeout: _testTimeout,
      () async {
        final client = wrap(
          _FakeClient((request) async {
            final body = StreamIterator(request.finalize());
            await body.moveNext();
            return Completer<Never>().future;
          }),
          streamsBody: true,
        );
        await expectLater(
          client.put(
            Uri.parse('http://example.test/'),
            body: Uint8List(640 * 1024),
          ),
          throwsA(
            isA<TimeoutException>().having(
              (e) => e.message,
              'message',
              startsWith('Request to'),
            ),
          ),
        );
      },
    );

    test('keeps the final URL of a redirected response', () async {
      final finalUrl = Uri.parse('http://example.test/final');
      final client = wrap(
        _FakeClient(
          (request) async => _ResponseWithUrl(
            Stream.value('ok'.codeUnits),
            200,
            url: finalUrl,
            request: request,
          ),
        ),
      );
      final response = await client.send(
        http.Request('GET', Uri.parse('http://example.test/start')),
      );
      expect((response as http.BaseResponseWithUrl).url, finalUrl);
    });

    test(
      'a paused response does not time out',
      timeout: _testTimeout,
      () async {
        final client = wrap(
          _FakeClient(
            (request) async => http.StreamedResponse(
              Stream.fromIterable([
                [1],
                [2],
              ]),
              200,
              request: request,
            ),
          ),
        );
        final response = await client.send(
          http.Request('GET', Uri.parse('http://example.test/')),
        );
        final received = <int>[];
        final done = Completer<void>();
        late StreamSubscription<List<int>> sub;
        sub = response.stream.listen(
          (chunk) {
            received.addAll(chunk);
            sub.pause(Future<void>.delayed(_idle * 2));
          },
          onError: done.completeError,
          onDone: done.complete,
        );
        addTearDown(sub.cancel);
        await done.future;
        expect(received, [1, 2]);
      },
    );
  });
}

/// A client whose [send] is [_handler].
class _FakeClient extends http.BaseClient {
  _FakeClient(this._handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest) _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      _handler(request);
}

class _ResponseWithUrl extends http.StreamedResponse
    implements http.BaseResponseWithUrl {
  _ResponseWithUrl(
    super.stream,
    super.statusCode, {
    required this.url,
    super.request,
  });

  @override
  final Uri url;
}

class _UnfinalizableRequest extends http.BaseRequest {
  _UnfinalizableRequest() : super('GET', Uri.parse('http://example.test/'));

  @override
  http.ByteStream finalize() {
    super.finalize();
    throw StateError('cannot finalize');
  }
}
