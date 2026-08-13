import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persistent [TokenStore] backed by iOS Keychain / Android Keystore.
class FlutterSecureStore implements TokenStore {
  final FlutterSecureStorage _storage;

  FlutterSecureStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  @override
  Future<String?> get(String key) => _storage.read(key: key);

  @override
  Future<void> set(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}
