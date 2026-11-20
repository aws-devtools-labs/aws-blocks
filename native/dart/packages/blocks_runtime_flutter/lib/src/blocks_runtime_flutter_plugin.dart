// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime_flutter/src/flutter_secure_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Makes the platform's secure storage the default session store, so a
/// Flutter app keeps its signed-in session across restarts without any code
/// of its own.
///
/// Flutter calls [registerWith] before `main` on Android, iOS, macOS, Linux
/// and Windows, because this package declares it as its Dart plugin class.
/// From then on a `Blocks` or `BlocksClient` built without a `sessionStore:`
/// keeps its cookies in a [PersistentSessionStore] over [FlutterSecureStore]
/// (storage key `_session_cookies`), one store shared by every such client.
/// The store reads the saved session before the first call and needs no
/// `WidgetsFlutterBinding.ensureInitialized()` from the app (see
/// [FlutterSecureStore]).
///
/// When the secure storage cannot be read or written, the session keeps
/// working from memory and the error is passed to `FlutterError.reportError`
/// as a silent error: it reaches `FlutterError.onError` (and so a crash
/// reporter hooked there) without showing in the console in release builds.
/// A macOS app without the `keychain-access-groups` entitlement fails this
/// way on every read; the report says so.
///
/// On the web nothing is registered: the browser keeps the session cookies
/// itself, and they are never visible to Dart. Flutter does not run the
/// plugin registrant under `flutter test`, so widget and unit tests keep
/// sessions in memory unless they call [registerWith].
///
/// To keep sessions in memory instead, pass `InMemorySessionStore()` as a
/// client's `sessionStore:`, or call `registerDefaultSessionStore(null)` at
/// the start of `main` for every client.
// Flutter's plugin registrant looks for a class with a static `registerWith`.
// ignore: avoid_classes_with_only_static_members
abstract final class BlocksRuntimeFlutterPlugin {
  /// Registers the secure-storage default with
  /// [registerDefaultSessionStore]. Called by Flutter before `main`; an app
  /// does not call it. Calling it again, at any time, does nothing.
  static void registerWith() => registerDefaultSessionStore(_createStore);

  static SessionStore _createStore() => PersistentSessionStore(
    store: FlutterSecureStore(),
    onPersistError: reportStorageError,
  );

  /// Reports a session storage error through `FlutterError.reportError` as a
  /// silent error, naming the missing macOS entitlement when that is the
  /// cause. The default store uses it as its `onPersistError`; pass it to a
  /// [PersistentSessionStore] you register yourself to keep that reporting.
  static void reportStorageError(Object error, StackTrace stackTrace) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: error,
        stack: stackTrace,
        library: 'blocks_runtime_flutter',
        context: ErrorDescription(
          'while reading or writing the stored session; the session is kept '
          'in memory for this run',
        ),
        silent: true,
        informationCollector: _isMissingEntitlement(error)
            ? () => [
                ErrorHint(
                  'The Keychain refused access because the app is missing '
                  'the keychain-access-groups entitlement '
                  '(errSecMissingEntitlement, -34018). Add it to '
                  'macos/Runner/DebugProfile.entitlements and '
                  'Release.entitlements; see the blocks_runtime_flutter '
                  'README.',
                ),
              ]
            : null,
      ),
    );
  }

  /// errSecMissingEntitlement, as flutter_secure_storage reports it.
  static bool _isMissingEntitlement(Object error) =>
      error is PlatformException && error.details == -34018;
}
