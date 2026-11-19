// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/annotations.dart';
import 'package:mockito/mockito.dart';

@GenerateMocks([AppLinks])
import 'flutter_browser_launcher_test.mocks.dart';

const _urlLauncherChannel = MethodChannel('plugins.flutter.io/url_launcher');
final _authorizeUrl = Uri.parse('https://provider.com/authorize');

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();

  /// Whether the mocked `url_launcher` reports that a browser opened.
  var browserOpens = true;

  /// Completes each time `url_launcher` is asked to open a URL.
  var opened = Completer<void>();

  late StreamController<Uri> links;
  late MockAppLinks appLinks;

  /// Steps the app's lifecycle through [states] one at a time, as the
  /// platform reports them.
  void setLifecycle(List<AppLifecycleState> states) {
    for (final state in states) {
      binding.handleAppLifecycleStateChanged(state);
    }
  }

  /// The browser comes to the front, then the user closes it.
  void leaveAndReturn() => setLifecycle(const [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ]);

  setUp(() {
    browserOpens = true;
    opened = Completer<void>();
    links = StreamController<Uri>.broadcast();
    appLinks = MockAppLinks();
    when(appLinks.uriLinkStream).thenAnswer((_) => links.stream);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    // Mock the url_launcher platform channel
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_urlLauncherChannel, (
          MethodCall methodCall,
        ) async {
          if (!opened.isCompleted) opened.complete();
          return browserOpens;
        });
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_urlLauncherChannel, null);
    await links.close();
  });

  test('implements BrowserLauncher', () {
    final launcher = FlutterBrowserLauncher(appLinks: appLinks);
    expect(launcher, isA<BrowserLauncher>());
  });

  test('launch returns callback URI matching scheme', () async {
    final launcher = FlutterBrowserLauncher(appLinks: appLinks);

    final callbackUri = Uri.parse('myapp://auth/callback?code=abc123');

    final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
    await opened.future;

    // Emit a non-matching URI first, then the matching one
    links
      ..add(Uri.parse('https://other.com/page'))
      ..add(callbackUri);

    final result = await future;
    expect(result, callbackUri);
    expect(links.hasListener, isFalse);
  });

  test('throws StateError when no browser opens', () async {
    browserOpens = false;
    final launcher = FlutterBrowserLauncher(appLinks: appLinks);

    await expectLater(
      launcher.launch(_authorizeUrl, callbackScheme: 'myapp'),
      throwsA(isA<StateError>()),
    );
    expect(links.hasListener, isFalse);
  });

  group('cancel', () {
    test('throws OidcCancelledException when cancel completes', () async {
      final cancel = Completer<void>();
      final launcher = FlutterBrowserLauncher(appLinks: appLinks);

      final future = launcher.launch(
        _authorizeUrl,
        callbackScheme: 'myapp',
        cancel: cancel.future,
      );
      await opened.future;
      cancel.complete();

      await expectLater(future, throwsA(isA<OidcCancelledException>()));
      expect(links.hasListener, isFalse);
    });

    test(
      'a cancel that completed before the launch opens no browser',
      () async {
        final launcher = FlutterBrowserLauncher(appLinks: appLinks);

        await expectLater(
          launcher.launch(
            _authorizeUrl,
            callbackScheme: 'myapp',
            cancel: Future<void>.value(),
          ),
          throwsA(isA<OidcCancelledException>()),
        );
        expect(opened.isCompleted, isFalse);
        expect(links.hasListener, isFalse);
      },
    );

    test('a cancel after the redirect changes nothing', () async {
      final cancel = Completer<void>();
      final launcher = FlutterBrowserLauncher(appLinks: appLinks);
      final callbackUri = Uri.parse('myapp://auth?code=c');

      final future = launcher.launch(
        _authorizeUrl,
        callbackScheme: 'myapp',
        cancel: cancel.future,
      );
      await opened.future;
      links.add(callbackUri);
      expect(await future, callbackUri);
      cancel.complete();
      await pumpEventQueue();
    });

    test('throws OidcCancelledException when the app is resumed without a '
        'redirect', () async {
      final launcher = FlutterBrowserLauncher(
        appLinks: appLinks,
        resumeGracePeriod: const Duration(milliseconds: 20),
      );

      final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
      await opened.future;
      leaveAndReturn();

      await expectLater(
        future,
        throwsA(
          isA<OidcCancelledException>().having(
            (e) => e.message,
            'message',
            contains('without a redirect'),
          ),
        ),
      );
      expect(links.hasListener, isFalse);
    });

    test(
      'returns a redirect that arrives just after the app is resumed',
      () async {
        final launcher = FlutterBrowserLauncher(
          appLinks: appLinks,
          resumeGracePeriod: const Duration(milliseconds: 200),
        );
        final callbackUri = Uri.parse('myapp://auth?code=c');

        final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
        await opened.future;
        leaveAndReturn();
        await Future<void>.delayed(const Duration(milliseconds: 20));
        links.add(callbackUri);

        expect(await future, callbackUri);
      },
    );

    test(
      'an inactive app that never left the foreground keeps waiting',
      () async {
        final launcher = FlutterBrowserLauncher(
          appLinks: appLinks,
          resumeGracePeriod: const Duration(milliseconds: 20),
        );
        final callbackUri = Uri.parse('myapp://auth?code=c');

        final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
        await opened.future;
        // A system dialog or the notification shade makes the app inactive
        // without hiding it.
        setLifecycle(const [
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]);
        await Future<void>.delayed(const Duration(milliseconds: 60));
        links.add(callbackUri);

        expect(await future, callbackUri);
      },
    );

    test('a null resumeGracePeriod turns the lifecycle check off', () async {
      final launcher = FlutterBrowserLauncher(
        appLinks: appLinks,
        resumeGracePeriod: null,
      );
      final callbackUri = Uri.parse('myapp://auth?code=c');

      final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
      await opened.future;
      leaveAndReturn();
      await Future<void>.delayed(const Duration(milliseconds: 60));
      links.add(callbackUri);

      expect(await future, callbackUri);
    });
  });

  group('timeout', () {
    test('throws OidcCancelledException once the timeout passes', () async {
      final launcher = FlutterBrowserLauncher(
        appLinks: appLinks,
        timeout: const Duration(milliseconds: 20),
      );

      await expectLater(
        launcher.launch(_authorizeUrl, callbackScheme: 'myapp'),
        throwsA(
          isA<OidcCancelledException>().having(
            (e) => e.message,
            'message',
            contains('timed out'),
          ),
        ),
      );
      expect(links.hasListener, isFalse);
    });

    test('returns a redirect that arrives before the timeout', () async {
      final launcher = FlutterBrowserLauncher(
        appLinks: appLinks,
        timeout: const Duration(seconds: 5),
      );
      final callbackUri = Uri.parse('myapp://auth?code=c');

      final future = launcher.launch(_authorizeUrl, callbackScheme: 'myapp');
      await opened.future;
      links.add(callbackUri);

      expect(await future, callbackUri);
    });
  });
}
