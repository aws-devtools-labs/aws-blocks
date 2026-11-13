import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:mockito/annotations.dart';
import 'package:mockito/mockito.dart';

@GenerateMocks([FlutterSecureStorage])
import 'flutter_secure_store_test.mocks.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockFlutterSecureStorage mockStorage;
  late FlutterSecureStore store;

  setUp(() {
    mockStorage = MockFlutterSecureStorage();
    store = FlutterSecureStore(storage: mockStorage);
  });

  test('implements TokenStore', () {
    expect(store, isA<TokenStore>());
  });

  test('get delegates to read', () async {
    when(mockStorage.read(key: 'token')).thenAnswer((_) async => 'value');

    final result = await store.get('token');

    expect(result, 'value');
    verify(mockStorage.read(key: 'token')).called(1);
  });

  test('get returns null when key missing', () async {
    when(mockStorage.read(key: 'missing')).thenAnswer((_) async => null);

    expect(await store.get('missing'), isNull);
  });

  test('set delegates to write', () async {
    when(mockStorage.write(key: 'k', value: 'v')).thenAnswer((_) async {});

    await store.set('k', 'v');

    verify(mockStorage.write(key: 'k', value: 'v')).called(1);
  });

  test('delete delegates to delete', () async {
    when(mockStorage.delete(key: 'k')).thenAnswer((_) async {});

    await store.delete('k');

    verify(mockStorage.delete(key: 'k')).called(1);
  });

  test('stores Apple Keychain items with this-device-only accessibility', () {
    expect(
      FlutterSecureStore.defaultStorage.iOptions.accessibility,
      KeychainAccessibility.unlocked_this_device,
    );
    expect(
      FlutterSecureStore.defaultStorage.mOptions.accessibility,
      KeychainAccessibility.unlocked_this_device,
    );
  });

  group('with previous storage', () {
    late MockFlutterSecureStorage previousStorage;

    setUp(() {
      previousStorage = MockFlutterSecureStorage();
      store = FlutterSecureStore.withPreviousStorage(
        storage: mockStorage,
        previousStorage: previousStorage,
      );
    });

    test('get prefers the current storage', () async {
      when(mockStorage.read(key: 'k')).thenAnswer((_) async => 'new');

      expect(await store.get('k'), 'new');
      verifyNever(previousStorage.read(key: 'k'));
    });

    test('get falls back to an item stored by an earlier version', () async {
      when(mockStorage.read(key: 'k')).thenAnswer((_) async => null);
      when(previousStorage.read(key: 'k')).thenAnswer((_) async => 'old');

      expect(await store.get('k'), 'old');
      verifyNever(mockStorage.delete(key: 'k'));
      verifyNever(mockStorage.write(key: 'k', value: anyNamed('value')));
    });

    test('set replaces an item stored by an earlier version', () async {
      when(mockStorage.containsKey(key: 'k')).thenAnswer((_) async => false);
      when(previousStorage.containsKey(key: 'k')).thenAnswer((_) async => true);
      when(mockStorage.delete(key: 'k')).thenAnswer((_) async {});
      when(mockStorage.write(key: 'k', value: 'v')).thenAnswer((_) async {});

      await store.set('k', 'v');

      verifyInOrder([
        mockStorage.delete(key: 'k'),
        mockStorage.write(key: 'k', value: 'v'),
      ]);
    });

    test('set updates an item already stored by this version', () async {
      when(mockStorage.containsKey(key: 'k')).thenAnswer((_) async => true);
      when(mockStorage.write(key: 'k', value: 'v')).thenAnswer((_) async {});

      await store.set('k', 'v');

      verifyNever(mockStorage.delete(key: 'k'));
      verifyNever(previousStorage.containsKey(key: 'k'));
      verify(mockStorage.write(key: 'k', value: 'v')).called(1);
    });

    test('set writes a fresh key without deleting', () async {
      when(mockStorage.containsKey(key: 'k')).thenAnswer((_) async => false);
      when(
        previousStorage.containsKey(key: 'k'),
      ).thenAnswer((_) async => false);
      when(mockStorage.write(key: 'k', value: 'v')).thenAnswer((_) async {});

      await store.set('k', 'v');

      verifyNever(mockStorage.delete(key: 'k'));
      verify(mockStorage.write(key: 'k', value: 'v')).called(1);
    });
  });

  // These go through the real FlutterSecureStorage option mapping and method
  // channel, with a fake Keychain on the other end, so they cover which
  // storage the default constructor wires up on which platform.
  for (final crossAccessibility in [false, true]) {
    final plugin = crossAccessibility
        ? 'flutter_secure_storage_darwin 0.4.3 and later'
        : 'flutter_secure_storage_darwin 0.4.0 through 0.4.2';

    group('default store with $plugin', () {
      late _FakeKeychain keychain;

      setUp(() {
        keychain = _FakeKeychain(crossAccessibility: crossAccessibility)
          ..install();
      });

      tearDown(() {
        keychain.uninstall();
        debugDefaultTargetPlatformOverride = null;
      });

      for (final platform in [TargetPlatform.iOS, TargetPlatform.macOS]) {
        test('on ${platform.name}, reads an item stored by an earlier version '
            'and moves it to this-device-only on the next set', () async {
          debugDefaultTargetPlatformOverride = platform;
          keychain.seed('k', 'old', accessibility: 'unlocked');
          final store = FlutterSecureStore();

          expect(await store.get('k'), 'old');
          expect(keychain.items['k']!.accessibility, 'unlocked');

          await store.set('k', 'new');

          expect(keychain.items['k']!.value, 'new');
          expect(keychain.items['k']!.accessibility, 'unlocked_this_device');
          expect(await store.get('k'), 'new');
        });
      }

      test('on android, reads and writes the current storage only', () async {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        final store = FlutterSecureStore();

        expect(await store.get('k'), isNull);
        await store.set('k', 'v');

        expect(keychain.calls, ['read', 'write']);
        expect(keychain.items['k']!.value, 'v');
      });
    });
  }
}

/// A Keychain item: its value and the accessibility it was stored with.
class _KeychainItem {
  _KeychainItem(this.value, this.accessibility);

  final String value;
  final String? accessibility;
}

/// Answers the flutter_secure_storage method channel the way the Keychain and
/// flutter_secure_storage_darwin do.
///
/// Items are identified by key alone: accessibility is not part of a Keychain
/// item's identity, so adding an item next to one with another accessibility
/// fails with errSecDuplicateItem. A read or containsKey matches only items
/// with the requested accessibility, unless [crossAccessibility] is set (as in
/// darwin 0.4.3, which falls back across accessibility levels and moves the
/// item on write). A delete matches every accessibility.
class _FakeKeychain {
  _FakeKeychain({required this.crossAccessibility});

  static const _channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final bool crossAccessibility;
  final Map<String, _KeychainItem> items = {};
  final List<String> calls = [];

  void install() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(_channel, _handle);

  void uninstall() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(_channel, null);

  void seed(String key, String value, {required String accessibility}) =>
      items[key] = _KeychainItem(value, accessibility);

  _KeychainItem? _find(String key, String? accessibility) {
    final item = items[key];
    if (item == null) return null;
    if (crossAccessibility || item.accessibility == accessibility) return item;
    return null;
  }

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call.method);
    final args = call.arguments as Map<Object?, Object?>;
    final key = args['key']! as String;
    final options = (args['options']! as Map<Object?, Object?>)
        .cast<String, String>();
    final accessibility = options['accessibility'];
    switch (call.method) {
      case 'read':
        return _find(key, accessibility)?.value;
      case 'containsKey':
        return _find(key, accessibility) != null;
      case 'delete':
        items.remove(key);
        return null;
      case 'write':
        final value = args['value']! as String;
        // An item the query finds is replaced under the requested
        // accessibility: by SecItemUpdate when the accessibility already
        // matches, otherwise (0.4.3) by the plugin's delete and add. An item
        // the query misses makes SecItemAdd fail.
        if (_find(key, accessibility) == null && items.containsKey(key)) {
          throw PlatformException(code: 'errSecDuplicateItem');
        }
        items[key] = _KeychainItem(value, accessibility);
        return null;
    }
    throw MissingPluginException(call.method);
  }
}
