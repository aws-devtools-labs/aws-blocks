import 'package:blocks_runtime/blocks_runtime.dart';

/// Web/WASM stub for [TokenStore].
///
/// `flutter_secure_storage` (iOS Keychain / Android Keystore) is not available
/// on the web, and its platform interface transitively imports `dart:io`, which
/// is not WASM-compatible. To keep `blocks_runtime_flutter` importable — and
/// WASM-compatible — on the web, this stub is selected instead of the native
/// implementation. Its methods throw [UnsupportedError]; web apps should supply
/// their own [TokenStore] (e.g. one backed by browser storage) when
/// constructing `BlocksClient`.
class FlutterSecureStore implements TokenStore {
  FlutterSecureStore() {
    throw UnsupportedError(
      'FlutterSecureStore is not supported on the web. Provide a '
      'web-specific TokenStore implementation when constructing BlocksClient.',
    );
  }

  @override
  Future<String?> get(String key) =>
      throw UnsupportedError('FlutterSecureStore is not supported on the web.');

  @override
  Future<void> set(String key, String value) =>
      throw UnsupportedError('FlutterSecureStore is not supported on the web.');

  @override
  Future<void> delete(String key) =>
      throw UnsupportedError('FlutterSecureStore is not supported on the web.');
}
