## Unreleased

### Breaking

- Requires the `blocks_runtime` release whose `BrowserLauncher.launch` takes
  a `cancel` parameter.
- `FlutterBrowserLauncher` no longer waits forever when the user closes the
  browser. When the app comes back to the foreground and no redirect arrives
  within `resumeGracePeriod` (2 seconds by default), the launch throws
  `OidcCancelledException`. Pass `resumeGracePeriod: null` to keep waiting.
  It also throws `OidcCancelledException` once its new optional `timeout`
  passes, or when the `cancel` future passed to `signIn` or `signInDirect`
  completes.
- `FlutterBrowserLauncher` throws a `StateError` when no browser could be
  opened. It used to wait forever.
- `FlutterBrowserLauncher` listens for the redirect before it opens the
  browser, so a redirect that arrives at once is no longer missed.
- **Behavior change:** this package is now a Dart plugin. On Android, iOS,
  macOS, Linux and Windows, Flutter registers a `PersistentSessionStore` over
  `FlutterSecureStore` as the default session store before `main`, so every
  `Blocks`, `BlocksClient` and `OidcClient` built without a `sessionStore`
  keeps the session across app restarts. To keep sessions in memory, pass
  `sessionStore: InMemorySessionStore()`, or call
  `registerDefaultSessionStore(null)` at the start of `main`. Nothing is
  registered on the web, or under `flutter test`; an `integration_test` run
  on a device keeps the session between runs. A storage error is passed to
  `FlutterError.reportError` as a silent error, once until storage works
  again, and the session is kept in memory.
- Platform setup the default store needs (see the README): on macOS the
  `keychain-access-groups` entitlement, without which every read fails with
  `errSecMissingEntitlement` (the report names it); on Android
  `android:allowBackup="false"` or a backup rule excluding the secure storage,
  since a restored copy cannot be decrypted; on Linux the libsecret runtime and
  a Secret Service.
- A `PersistentSessionStore(store: FlutterSecureStore())` you build yourself
  must be the only one over its storage key: pass it to every client, or drop
  it and use the default.
- `FlutterSecureStore` creates the Flutter binding
  (`WidgetsFlutterBinding.ensureInitialized()`) on the main isolate before its
  first read or write, so it can be used before `runApp` without the app
  initializing the binding first.

## 0.2.0

- `FlutterSecureStore()` now stores iOS and macOS Keychain items with
  `KeychainAccessibility.unlocked_this_device`
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) instead of the
  flutter_secure_storage default, `KeychainAccessibility.unlocked`, matching
  the Swift and Kotlin runtimes. Items written by an earlier version are still
  read, so a signed-in session survives the upgrade, and each one moves to the
  new accessibility the next time it is written. As before, items can be read
  only while the device is unlocked; the only difference is that they are no
  longer restored from a backup onto another device. A store built with your
  own `storage` argument is unchanged and uses that storage's options as given.

## 0.1.4

- Require `flutter_secure_storage` `^11.1.0`; 11.1.0 targets a compileSdk supported by current stable Flutter/AGP, fixing the Android build break that forced the earlier 10.x pin ([flutter_secure_storage#1224](https://github.com/juliansteenbakker/flutter_secure_storage/issues/1224))

## 0.1.3

- Pin `flutter_secure_storage` to `^10.3.1`; 11.x requires Android compileSdk 37, which breaks Android builds on current stable Flutter/AGP ([flutter_secure_storage#1224](https://github.com/juliansteenbakker/flutter_secure_storage/issues/1224))

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
