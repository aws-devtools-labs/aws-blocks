@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/loopback_session_io.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

/// An opener that does nothing, leaving the test to play the browser.
Future<void> _noBrowser(Uri _) async {}

/// GETs [url] on the loopback listener without following redirects.
Future<http.Response> _get(String url) async {
  final request = http.Request('GET', Uri.parse(url))..followRedirects = false;
  return http.Response.fromStream(await http.Client().send(request));
}

void main() {
  group('LoopbackSession', () {
    test(
      'relays to 127.0.0.1 on an OS-picked port at /oidc/callback',
      () async {
        final session = await LoopbackSession.open(openUrl: _noBrowser);
        addTearDown(session.close);
        final relay = Uri.parse(session.relayTo);
        expect(relay.scheme, 'http');
        expect(relay.host, '127.0.0.1');
        expect(relay.port, isNot(0));
        expect(relay.path, '/oidc/callback');
      },
    );

    test('returns the redirect that carries the expected state', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      final redirect = session.awaitRedirect(
        Uri.parse('https://idp.example.com/authorize'),
        expectedState: 's1',
      );
      final response = await _get('${session.relayTo}?code=c&state=s1');

      expect(response.statusCode, 200);
      expect(response.body, contains('return to the app'));
      expect(response.body, isNot(contains('complete')));
      final uri = await redirect;
      expect(uri.queryParameters, {'code': 'c', 'state': 's1'});
    });

    test(
      'returns an IdP error redirect that carries the expected state',
      () async {
        final session = await LoopbackSession.open(openUrl: _noBrowser);
        final redirect = session.awaitRedirect(
          Uri.parse('https://idp.example.com/authorize'),
          expectedState: 's1',
        );
        final response = await _get(
          '${session.relayTo}?error=access_denied&state=s1',
        );

        expect(response.body, contains('Sign-in failed'));
        expect(response.body, isNot(contains('access_denied')));
        expect((await redirect).queryParameters['error'], 'access_denied');
      },
    );

    test('answers 404 to anything else and keeps waiting', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      final redirect = session.awaitRedirect(
        Uri.parse('https://idp.example.com/authorize'),
        expectedState: 's1',
      );
      final base = Uri.parse(session.relayTo);
      final origin = '${base.scheme}://${base.authority}';
      for (final url in [
        '$origin/favicon.ico',
        '$origin/other?code=c&state=s1',
        session.relayTo,
        '${session.relayTo}?code=c',
        '${session.relayTo}?code=c&state=forged',
        '${session.relayTo}?state=s1',
        '${session.relayTo}?code=&state=s1',
        '${session.relayTo}?code=c&state=s',
        '$origin/oidc/start',
      ]) {
        expect((await _get(url)).statusCode, 404, reason: url);
      }

      await _get('${session.relayTo}?code=c&state=s1');
      expect((await redirect).queryParameters['code'], 'c');
    });

    test('answers 404 to a redirect that arrives before the wait', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      addTearDown(session.close);
      expect(
        (await _get('${session.relayTo}?code=c&state=s1')).statusCode,
        404,
      );
    });

    test(
      'answers 400 to a query with bad percent-encoding and keeps waiting',
      () async {
        final errors = <Object>[];
        await runZonedGuarded(() async {
          final session = await LoopbackSession.open(openUrl: _noBrowser);
          final redirect = session.awaitRedirect(
            Uri.parse('https://idp.example.com/authorize'),
            expectedState: 's1',
          );
          final port = Uri.parse(session.relayTo).port;
          final socket = await Socket.connect('127.0.0.1', port);
          socket.write(
            'GET /oidc/callback?a=%E0%A4%A HTTP/1.1\r\n'
            'Host: 127.0.0.1:$port\r\nConnection: close\r\n\r\n',
          );
          final reply = await utf8.decoder.bind(socket).join();
          socket.destroy();
          expect(reply, startsWith('HTTP/1.1 400'));

          await _get('${session.relayTo}?code=c&state=s1');
          expect((await redirect).queryParameters['code'], 'c');
        }, (e, _) => errors.add(e));
        expect(errors, isEmpty);
      },
    );

    test('cancel before the redirect throws and closes the listener', () async {
      final cancel = Completer<void>();
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      final redirect = session.awaitRedirect(
        Uri.parse('https://idp.example.com/authorize'),
        expectedState: 's1',
        cancel: cancel.future,
      );
      cancel.complete();
      await expectLater(redirect, throwsA(isA<OidcCancelledException>()));
      await expectLater(_get(session.relayTo), throwsA(anything));
    });

    test('cancel after the redirect arrived changes nothing', () async {
      final cancel = Completer<void>();
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      final redirect = session.awaitRedirect(
        Uri.parse('https://idp.example.com/authorize'),
        expectedState: 's1',
        cancel: cancel.future,
      );
      await _get('${session.relayTo}?code=c&state=s1');
      expect((await redirect).queryParameters['code'], 'c');
      cancel.complete();
      await Future<void>.delayed(Duration.zero);
      await expectLater(_get(session.relayTo), throwsA(anything));
    });

    test('answers 404 to a POST that carries the redirect', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      final redirect = session.awaitRedirect(
        Uri.parse('https://idp.example.com/authorize'),
        expectedState: 's1',
      );
      final post = await http.post(
        Uri.parse('${session.relayTo}?code=c&state=s1'),
      );
      expect(post.statusCode, 404);
      await _get('${session.relayTo}?code=c&state=s1');
      expect((await redirect).queryParameters['code'], 'c');
    });

    test(
      'returns the redirect while the app opener is still running',
      () async {
        final session = await LoopbackSession.open(
          openUrl: (_) => Completer<void>().future,
          timeout: const Duration(seconds: 5),
        );
        final redirect = session.awaitRedirect(
          Uri.parse('https://idp.example.com/authorize'),
          expectedState: 's1',
        );
        await _get('${session.relayTo}?code=c&state=s1');
        expect((await redirect).queryParameters['code'], 'c');
      },
    );

    test(
      'returns the redirect while the platform handler is still running',
      () async {
        final session = await LoopbackSession.open(
          platformOpen: (_) => Completer<void>().future,
          timeout: const Duration(seconds: 5),
        );
        final redirect = session.awaitRedirect(
          Uri.parse('https://idp.example.com/authorize'),
          expectedState: 's1',
        );
        await _get('${session.relayTo}?code=c&state=s1');
        expect((await redirect).queryParameters['code'], 'c');
      },
    );

    test(
      'a failed platform handler prints a one-time start URL and keeps waiting',
      () async {
        final printed = <String>[];
        final session = await LoopbackSession.open(
          platformOpen: (_) async => throw const ProcessException('open', []),
          printLine: printed.add,
        );
        const authorize = 'https://idp.example.com/authorize?a=1&b=2&state=s1';
        final redirect = session.awaitRedirect(
          Uri.parse(authorize),
          expectedState: 's1',
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));

        final start = RegExp(
          r'http://127\.0\.0\.1:\d+/oidc/start/[A-Za-z0-9_-]{20,}',
        ).firstMatch(printed.join('\n'))?.group(0);
        expect(start, isNotNull);
        expect(printed.join(), isNot(contains('state=')));
        expect((await http.post(Uri.parse(start!))).statusCode, 404);
        final first = await _get(start);
        expect(first.statusCode, 302);
        expect(first.headers['location'], authorize);
        expect((await _get(start)).statusCode, 404);

        await _get('${session.relayTo}?code=c&state=s1');
        expect((await redirect).queryParameters['code'], 'c');
      },
    );

    test('serves no start URL when the browser opened', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      unawaited(
        session
            .awaitRedirect(
              Uri.parse('https://idp.example.com/authorize?state=s1'),
              expectedState: 's1',
            )
            .then((_) {}, onError: (Object _) {}),
      );
      final relay = Uri.parse(session.relayTo);
      expect(
        (await _get('http://127.0.0.1:${relay.port}/oidc/start')).statusCode,
        404,
      );
      await session.close();
    });

    for (final url in [
      'file:///etc/passwd',
      'http://idp.example.com/authorize',
      'myapp://auth',
    ]) {
      test('refuses to open $url', () async {
        var opened = false;
        final session = await LoopbackSession.open(
          openUrl: (_) async => opened = true,
        );
        await expectLater(
          session.awaitRedirect(Uri.parse(url), expectedState: 's1'),
          throwsA(isA<ArgumentError>()),
        );
        expect(opened, isFalse);
        await expectLater(_get(session.relayTo), throwsA(anything));
      });
    }

    test(
      'times out with OidcCancelledException and closes the listener',
      () async {
        final session = await LoopbackSession.open(
          openUrl: _noBrowser,
          timeout: const Duration(milliseconds: 100),
        );
        await expectLater(
          session.awaitRedirect(
            Uri.parse('https://idp.example.com/authorize'),
            expectedState: 's1',
          ),
          throwsA(
            isA<OidcCancelledException>().having(
              (e) => e.message,
              'message',
              contains('timed out'),
            ),
          ),
        );
        await expectLater(_get(session.relayTo), throwsA(anything));
      },
    );

    test('one deadline covers an opener that never returns', () async {
      // Without a shared deadline the opener's await never ends, the timer's
      // error has no listener, and the listener is never closed.
      final session = await LoopbackSession.open(
        openUrl: (_) => Completer<void>().future,
        timeout: const Duration(milliseconds: 100),
      );
      await expectLater(
        session.awaitRedirect(
          Uri.parse('https://idp.example.com/authorize'),
          expectedState: 's1',
        ),
        throwsA(isA<OidcCancelledException>()),
      );
      await expectLater(_get(session.relayTo), throwsA(anything));
    });

    test(
      'an opener that throws fails the wait and closes the listener',
      () async {
        final session = await LoopbackSession.open(
          openUrl: (_) async => throw StateError('no browser'),
        );
        await expectLater(
          session.awaitRedirect(
            Uri.parse('https://idp.example.com/authorize'),
            expectedState: 's1',
          ),
          throwsA(isA<StateError>()),
        );
        await expectLater(_get(session.relayTo), throwsA(anything));
      },
    );

    test('close is safe to call twice', () async {
      final session = await LoopbackSession.open(openUrl: _noBrowser);
      await session.close();
      await session.close();
    });
  });

  group('openUrlWithPlatformHandler', () {
    test('returns once the handler exits, though its child keeps the output '
        'open', () async {
      // A handler that starts a browser which inherits its output and keeps
      // running, then exits 0, as xdg-open can.
      final sw = Stopwatch()..start();
      await runOpenerForTest(['sh', '-c', '(sleep 5) & echo started; exit 0']);
      expect(sw.elapsed, lessThan(const Duration(seconds: 3)));
    }, testOn: 'mac-os || linux');

    test('throws when the handler exits with an error', () async {
      await expectLater(
        runOpenerForTest(['sh', '-c', 'exit 3']),
        throwsA(isA<ProcessException>()),
      );
    }, testOn: 'mac-os || linux');
  });

  group('browserCommand', () {
    const url = 'https://idp.example.com/authorize?a=1&b=2';

    test('uses open on macOS', () {
      expect(browserCommand('macos', url), ['open', url]);
    });

    test('uses rundll32 on Windows, never a shell', () {
      expect(browserCommand('windows', url), [
        'rundll32',
        'url.dll,FileProtocolHandler',
        url,
      ]);
    });

    test('uses xdg-open on Linux and anything else', () {
      expect(browserCommand('linux', url), ['xdg-open', url]);
    });
  });

  test('loopbackSupported is true on desktop', () {
    expect(
      loopbackSupported,
      Platform.isMacOS || Platform.isLinux || Platform.isWindows,
    );
  });
}
