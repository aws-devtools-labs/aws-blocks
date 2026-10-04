## Unreleased

- Generate `UnknownTransferable` (with an `AWSBLOCKS-NATIVE-001` diagnostic) for
  a direct result whose transferable tag has no known binding, instead of `dynamic`.
- Hydrate a nullable bound transferable result (e.g. `RealtimeChannel<T>?`)
  via its `fromJson` factory instead of leaving it as a raw map.
- Call `fromJson` for a `realtime/channel` message only when its type argument
  is an object; a `dynamic` or absent argument yields a live
  `RealtimeChannel<dynamic>`, and a concrete primitive or list stays raw
  instead of emitting a non-compiling `fromJson` call.

## 0.1.4

- Bump `blocks_runtime` to `^0.1.4`

## 0.1.3

- Minor bug fixes and improvements

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
