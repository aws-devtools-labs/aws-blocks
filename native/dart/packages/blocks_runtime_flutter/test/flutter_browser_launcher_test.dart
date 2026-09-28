import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:mockito/annotations.dart';
import 'package:mockito/mockito.dart';

@GenerateMocks([AppLinks])
import 'flutter_browser_launcher_test.mocks.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Mock the url_launcher platform channel
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          (MethodCall methodCall) async => true,
        );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          null,
        );
  });

  test('implements BrowserLauncher', () {
    final mockAppLinks = MockAppLinks();
    when(mockAppLinks.uriLinkStream).thenAnswer((_) => const Stream.empty());

    final launcher = FlutterBrowserLauncher(appLinks: mockAppLinks);
    expect(launcher, isA<BrowserLauncher>());
  });

  test('launch returns callback URI matching scheme', () async {
    final mockAppLinks = MockAppLinks();
    final controller = StreamController<Uri>();

    when(mockAppLinks.uriLinkStream).thenAnswer((_) => controller.stream);

    final launcher = FlutterBrowserLauncher(appLinks: mockAppLinks);

    final callbackUri = Uri.parse('myapp://auth/callback?code=abc123');

    final future = launcher.launch(
      Uri.parse('https://provider.com/authorize'),
      callbackScheme: 'myapp',
    );

    // Emit a non-matching URI first, then the matching one
    controller.add(Uri.parse('https://other.com/page'));
    controller.add(callbackUri);

    final result = await future;
    expect(result, callbackUri);

    await controller.close();
  });
}
