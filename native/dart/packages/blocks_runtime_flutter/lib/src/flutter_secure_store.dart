/// Exports the platform-appropriate [FlutterSecureStore] implementation.
///
/// Native platforms use `flutter_secure_storage` (iOS Keychain / Android
/// Keystore). That package transitively imports `dart:io`, which is not
/// WASM-compatible, so the web/WASM build selects a stub instead — keeping this
/// package importable and WASM-compatible on the web.
library;

export 'flutter_secure_store_io.dart'
    if (dart.library.js_interop) 'flutter_secure_store_web.dart';
