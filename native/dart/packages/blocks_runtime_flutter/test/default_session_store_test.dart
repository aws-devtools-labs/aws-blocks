// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Stands in for the platform side of flutter_secure_storage: the Keychain or
/// Keystore, which outlives the app process.
final _device = <String, String>{};

const _channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

const _api = 'https://api.example.com/cdk-blocks/api';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _device.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          final args = (call.arguments as Map<Object?, Object?>)
              .cast<String, Object?>();
          final key = args['key'] as String?;
          switch (call.method) {
            case 'read':
              return _device[key];
            case 'write':
              _device[key!] = args['value']! as String;
              return null;
            case 'delete':
              _device.remove(key);
              return null;
            case 'containsKey':
              return _device.containsKey(key);
          }
          return null;
        });
  });

  tearDown(() => registerDefaultSessionStore(null));

  /// One app launch: what Flutter does before main, then a client built the
  /// way generated code builds one, with no session store of its own.
  BlocksClient launch(http.Client server) {
    BlocksRuntimeFlutterPlugin.registerWith();
    return BlocksClient(baseUrl: _api, client: server);
  }

  test('registerWith makes a shared secure-storage store the default', () {
    BlocksRuntimeFlutterPlugin.registerWith();
    final a = BlocksClient(baseUrl: _api);
    final b = BlocksClient(baseUrl: _api);
    expect(a.sessionStore, isA<PersistentSessionStore>());
    expect(identical(a.sessionStore, b.sessionStore), isTrue);
  });

  test('registerWith again, even after a client exists, keeps one store', () {
    BlocksRuntimeFlutterPlugin.registerWith();
    final first = BlocksClient(baseUrl: _api).sessionStore;
    BlocksRuntimeFlutterPlugin.registerWith();
    expect(identical(BlocksClient(baseUrl: _api).sessionStore, first), isTrue);
  });

  test('another store registered after a client exists throws', () {
    BlocksRuntimeFlutterPlugin.registerWith();
    BlocksClient(baseUrl: _api);
    expect(
      () => registerDefaultSessionStore(InMemorySessionStore.new),
      throwsStateError,
    );
  });

  test('a storage error is reported to FlutterError.onError, once', () async {
    final reported = <FlutterErrorDetails>[];
    final previous = FlutterError.onError;
    FlutterError.onError = reported.add;
    addTearDown(() => FlutterError.onError = previous);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          _channel,
          (_) async => throw PlatformException(
            code: 'Unexpected security result code',
            message: 'A required entitlement is not present.',
            details: -34018,
          ),
        );

    final client = launch(
      MockClient(
        (_) async => http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
          200,
        ),
      ),
    );
    await client.call('authApi.getAuthState', const []);
    await client.call('authApi.getAuthState', const []);
    await pumpEventQueue();

    expect(reported, hasLength(1));
    expect(reported.single.silent, isTrue);
    expect(reported.single.library, 'blocks_runtime_flutter');
    expect(reported.single.toString(), contains('keychain-access-groups'));
  });

  test('a signed-in session survives an app restart', () async {
    final cookies = <String?>[];
    final server = MockClient((request) async {
      cookies.add(request.headers['cookie']);
      final method =
          (jsonDecode(request.body) as Map<String, dynamic>)['method'];
      return http.Response(
        jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
        200,
        headers: {
          if (method == 'authApi.signIn')
            'set-cookie': 'blocks_session=s1; Path=/; HttpOnly; Secure',
        },
      );
    });

    final first = launch(server);
    await first.call('authApi.signIn', const []);
    await first.call('authApi.getAuthState', const []);
    // Let the write-through reach the platform channel.
    await pumpEventQueue();
    expect(_device.keys, ['_session_cookies']);

    final second = launch(server);
    await second.call('authApi.getAuthState', const []);
    expect(cookies, [null, 'blocks_session=s1', 'blocks_session=s1']);
  });

  test('an explicit InMemorySessionStore opts out', () async {
    BlocksRuntimeFlutterPlugin.registerWith();
    final client = BlocksClient(
      baseUrl: _api,
      sessionStore: InMemorySessionStore(),
      client: MockClient(
        (_) async => http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
          200,
          headers: {'set-cookie': 'blocks_session=s1; Path=/'},
        ),
      ),
    );
    await client.call('authApi.signIn', const []);
    await pumpEventQueue();
    expect(_device, isEmpty);
  });
}
