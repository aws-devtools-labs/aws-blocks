## Unreleased

- Generate `UnknownTransferable` (with an `AWSBLOCKS-NATIVE-001` diagnostic) for
  a direct result whose transferable tag has no known binding, instead of `dynamic`.
- Hydrate a nullable bound transferable result (e.g. `RealtimeChannel<T>?`)
  via its `fromJson` factory instead of leaving it as a raw map.
- Hydrate a `realtime/channel` message when its type argument is an object
  (via `fromJson`) or a `Map` (decoded per value); a `dynamic`, `dynamic?`, or
  absent argument yields a live `RealtimeChannel<dynamic>` with an identity
  decoder.
- Leave a `realtime/channel` message un-hydrated when its type argument is a
  concrete primitive, list, or enum: the `Map`-only runtime cannot decode it.
  The declared `RealtimeChannel<T>` is returned as the raw descriptor map, so
  reading it throws a `_TypeError` at the call site; an `AWSBLOCKS-NATIVE-002`
  diagnostic names the operation and message type.

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
