## Unreleased

- `BlocksClient.call` accepts its `params` as a `List` (positional) as well
  as a `Map`, and throws an `ArgumentError` for anything else before sending.
  Generated clients now send a list: an AWS Blocks server reads params by
  position, so a map that leaves a key out moves the later values up a slot.
- Add `RealtimeChannel.fromJsonValue`, which decodes each message's payload as
  any JSON value, for channels whose message type isn't an object (such as
  `RealtimeChannel<List<String>>`). `RealtimeChannel.fromJson` is unchanged.
- Add `UnknownTransferable`, returned for a direct method result whose
  transferable tag has no known runtime binding, instead of untyped `dynamic`.
- Fix `OidcClient`'s default `authorizeParamsBasePath` and `callbackPath`:
  they were `/auth/authorize-params` and `/auth/callback`, routes no auth
  block serves. They are now `/aws-blocks/auth/authorize-params` and
  `/aws-blocks/auth/callback` (exposed as
  `OidcClient.defaultAuthorizeParamsBasePath` and
  `OidcClient.defaultCallbackPath`), matching the backend's routes. A client
  built from a descriptor that names both paths is unchanged.
- Add `blocksDeepEquals` and `blocksDeepHash`, value equality for lists and
  maps (recursively, with a map's key order ignored). Generated models use
  them to compare their list and map fields.
- Add `toJson()` to `RealtimeChannel`, `FileDownloadHandle`,
  `FileUploadHandle`, `OidcClient` and `UnknownTransferable`. It returns the
  `{"__blocks": …}` descriptor the value was hydrated from, unchanged (keys
  this runtime doesn't read included), as a copy. An `OidcClient` built with
  its constructor describes its providers and paths, in the shape
  `OidcClient.fromJson` reads. Generated clients send a transferable this way
  when a call passes one back to the server, and `jsonEncode` calls it too.

## 0.1.4

- Send the `aws-blocks-dart` user-agent token on outbound runtime requests

## 0.1.3

- Minor bug fixes and improvements

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
