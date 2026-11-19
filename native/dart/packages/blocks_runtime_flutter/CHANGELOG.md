## 1.0.0

### Breaking

- Requires `blocks_runtime` 1.0.0.
- This package is now a Dart plugin that registers a secure-storage session
  store as the default on Android, iOS, macOS, Linux and Windows, so sessions
  survive app restarts. Call `registerDefaultSessionStore(null)` to opt out.
  See the README for the platform setup this needs.
- `FlutterBrowserLauncher` throws `OidcCancelledException` when the user closes
  the browser, on `timeout`, or when `cancel` completes, and a `StateError` when
  no browser opens. It used to wait forever.

### Other changes

- `FlutterBrowserLauncher` no longer misses a redirect that arrives right away.
- `FlutterSecureStore` can be used before `runApp`.

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
