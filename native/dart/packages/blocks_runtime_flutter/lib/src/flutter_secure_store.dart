import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persistent [TokenStore] backed by iOS Keychain / Android Keystore.
///
/// On iOS and macOS, items are stored with
/// [KeychainAccessibility.unlocked_this_device]
/// (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`): they can be read only
/// while the device is unlocked, and do not move to another device. This
/// matches the Swift and Kotlin runtimes.
class FlutterSecureStore implements TokenStore {
  /// Creates a store. Pass [storage] to configure flutter_secure_storage
  /// yourself; its options are then used as given, and items stored by an
  /// earlier version of this package are not looked up.
  FlutterSecureStore({FlutterSecureStorage? storage})
    : _storage = storage ?? defaultStorage,
      _previousStorage = storage == null && _isApplePlatform()
          ? _previousDefaultStorage
          : null;

  /// Creates a store that also reads items from [previousStorage], as the
  /// default constructor does on iOS and macOS.
  @visibleForTesting
  FlutterSecureStore.withPreviousStorage({
    required FlutterSecureStorage storage,
    required FlutterSecureStorage previousStorage,
  }) : _storage = storage,
       _previousStorage = previousStorage;

  /// The storage the default constructor uses.
  @visibleForTesting
  static const FlutterSecureStorage defaultStorage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
    mOptions: MacOsOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );

  /// Storage configured as earlier versions of this package configured it,
  /// with the plugin's default accessibility
  /// ([KeychainAccessibility.unlocked]).
  static const FlutterSecureStorage _previousDefaultStorage =
      FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  /// Where items written by an earlier version of this package can be found,
  /// or null when there is nothing to fall back to.
  ///
  /// flutter_secure_storage_darwin 0.4.0 through 0.4.2 include
  /// `kSecAttrAccessible` in their Keychain queries, so an item stored with the
  /// previous accessibility is not found by a read or `containsKey` made with
  /// the new one (delete matches every accessibility). 0.4.3 and later fall
  /// back across accessibility levels and migrate the item on write
  /// themselves. The fallback read in [get] and the delete-before-write in
  /// [set] exist for apps that resolve 0.4.0 through 0.4.2, and are harmless
  /// no-ops on 0.4.3 and later.
  final FlutterSecureStorage? _previousStorage;

  /// Only the Apple options changed, so only there can an item exist under
  /// the previous configuration but not the current one.
  static bool _isApplePlatform() =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.iOS ||
          defaultTargetPlatform == TargetPlatform.macOS);

  @override
  Future<String?> get(String key) async {
    final value = await _storage.read(key: key);
    final previous = _previousStorage;
    if (value != null || previous == null) return value;
    // An item written by an earlier version keeps its accessibility until it
    // is next written (see [set]); reading it here keeps a signed-in session
    // across the upgrade. Nothing is rewritten on read, so a read never risks
    // losing the stored value.
    return previous.read(key: key);
  }

  /// The containsKey/delete/write sequence is not atomic: if the process dies
  /// between the delete and the write, the value is lost and the user signs
  /// in again. The plugin's own write has the same window.
  @override
  Future<void> set(String key, String value) async {
    final previous = _previousStorage;
    if (previous != null &&
        !await _storage.containsKey(key: key) &&
        await previous.containsKey(key: key)) {
      // Accessibility is not part of a Keychain item's identity, so adding an
      // item next to one stored with another accessibility fails with
      // errSecDuplicateItem. Remove the old one first; delete matches every
      // accessibility.
      await _storage.delete(key: key);
    }
    await _storage.write(key: key, value: value);
  }

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}
