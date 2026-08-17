import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/annotations.dart';
import 'package:mockito/mockito.dart';

@GenerateMocks([AppLinks])
import 'flutter_browser_launcher_test.mocks.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  var launchCalls = 0;
  var launchResult = true;
  void Function()? onLaunch;

  setUp(() {
    launchCalls = 0;
    launchResult = true;
    onLaunch = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          (MethodCall methodCall) async {
            if (methodCall.method == 'launch') {
              launchCalls++;
              onLaunch?.call();
              return launchResult;
            }
            return true;
          },
        );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          null,
        );
  });

  /// Tests must pass a broadcast stream: production `uriLinkStream` is one, and
  /// a single-subscription controller would buffer events emitted before the
  /// launcher subscribes, hiding dropped redirects.
  MockAppLinks mockLinks(Stream<Uri> stream, {Uri? initialLink}) {
    final mock = MockAppLinks();
    when(mock.uriLinkStream).thenAnswer((_) => stream);
    when(mock.getInitialLink()).thenAnswer((_) async => initialLink);
    return mock;
  }

  test('implements BrowserLauncher', () {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
    );
    expect(launcher, isA<BrowserLauncher>());
  });

  test('launch returns callback URI matching scheme', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
    );
    final callbackUri = Uri.parse('myapp://auth/callback?code=abc123');

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );

    controller.add(Uri.parse('https://other.com/page'));
    controller.add(callbackUri);

    expect(await future, callbackUri);
    expect(launchCalls, 1);
  });

  test(
    'captures a redirect that arrives the moment the browser opens',
    () async {
      final controller = StreamController<Uri>.broadcast();
      addTearDown(controller.close);

      final callbackUri = Uri.parse('myapp://auth/callback?code=fast');
      onLaunch = () => controller.add(callbackUri);

      final launcher = FlutterBrowserLauncher(
        appLinks: mockLinks(controller.stream),
      );

      final result = await launcher.launch(
        Uri.parse('https://provider.com/authorize'),
        callbackScheme: 'myapp',
      );

      expect(result, callbackUri);
    },
  );

  test('ignores redirects on other schemes', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
      timeout: const Duration(milliseconds: 200),
    );

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );

    controller
      ..add(Uri.parse('https://other.com/page'))
      ..add(Uri.parse('otherapp://auth/callback?code=nope'));

    await expectLater(future, throwsA(isA<OidcCancelledException>()));
  });

  test(
    'times out instead of hanging when the user dismisses the browser',
    () async {
      final controller = StreamController<Uri>.broadcast();
      addTearDown(controller.close);

      final launcher = FlutterBrowserLauncher(
        appLinks: mockLinks(controller.stream),
        timeout: const Duration(milliseconds: 50),
      );

      await expectLater(
        launcher.launch(
          Uri.parse('https://provider.com/authorize'),
          callbackScheme: 'myapp',
        ),
        throwsA(isA<OidcCancelledException>()),
      );
    },
  );

  test('throws when the link stream closes before a redirect', () async {
    final controller = StreamController<Uri>.broadcast();

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
    );

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );
    final expectation = expectLater(
      future,
      throwsA(isA<OidcCancelledException>()),
    );

    await controller.close();
    await expectation;
  });

  test('surfaces link stream errors as OidcCallbackException', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
    );

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );
    final expectation = expectLater(
      future,
      throwsA(isA<OidcCallbackException>()),
    );

    controller.addError(Exception('platform channel died'));
    await expectation;
  });

  test('throws when the browser cannot be opened', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    launchResult = false;

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
      // Long timeout: the failure must surface immediately, not by timing out.
      timeout: const Duration(minutes: 5),
    );

    await expectLater(
      launcher.launch(
        Uri.parse('https://provider.com/authorize'),
        callbackScheme: 'myapp',
      ),
      throwsA(isA<OidcCallbackException>()),
    );
    expect(launchCalls, 1);
  });

  test(
    'uses the initial link on cold start without opening a browser',
    () async {
      final controller = StreamController<Uri>.broadcast();
      addTearDown(controller.close);

      final callbackUri = Uri.parse('myapp://auth/callback?code=coldstart');
      final launcher = FlutterBrowserLauncher(
        appLinks: mockLinks(controller.stream, initialLink: callbackUri),
      );

      final result = await launcher.launch(
        Uri.parse('https://provider.com/authorize'),
        callbackScheme: 'myapp',
      );

      expect(result, callbackUri);
      expect(launchCalls, 0);
    },
  );

  test('ignores an initial link on a different scheme', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final callbackUri = Uri.parse('myapp://auth/callback?code=stream');
    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(
        controller.stream,
        initialLink: Uri.parse('https://unrelated.com/opened-the-app'),
      ),
    );

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );
    controller.add(callbackUri);

    expect(await future, callbackUri);
    expect(launchCalls, 1);
  });

  test('does not reuse a stale initial link on a second sign-in', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final coldStartUri = Uri.parse('myapp://auth/callback?code=first');
    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream, initialLink: coldStartUri),
    );

    expect(
      await launcher.launch(
        Uri.parse('https://provider.com/authorize'),
        callbackScheme: 'myapp',
      ),
      coldStartUri,
    );

    final freshUri = Uri.parse('myapp://auth/callback?code=second');
    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );
    controller.add(freshUri);

    expect(await future, freshUri);
    expect(launchCalls, 1);
  });

  test(
    'does not double-handle an initial link that also hits the stream',
    () async {
      final controller = StreamController<Uri>.broadcast();
      addTearDown(controller.close);

      final callbackUri = Uri.parse('myapp://auth/callback?code=both');
      final launcher = FlutterBrowserLauncher(
        appLinks: mockLinks(controller.stream, initialLink: callbackUri),
      );

      final future = launcher.launch(
        Uri.parse('https://provider.com/authorize'),
        callbackScheme: 'myapp',
      );
      controller.add(callbackUri);

      expect(await future, callbackUri);
    },
  );

  test('concurrent launches both observe the redirect', () async {
    final controller = StreamController<Uri>.broadcast();
    addTearDown(controller.close);

    final launcher = FlutterBrowserLauncher(
      appLinks: mockLinks(controller.stream),
    );
    final callbackUri = Uri.parse('myapp://auth/callback?code=shared');

    final first = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );
    final second = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );

    controller.add(callbackUri);

    expect(await first, callbackUri);
    expect(await second, callbackUri);
  });
}
