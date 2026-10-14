## Unreleased

- Add `validateTransferableDescriptor`, which returns a transferable descriptor
  after checking its `__blocks` tag against the tag the spec declared, for the
  `blocks-transferable-v1` factories that generated clients call. For a generic
  arity of one that factory must be a constructor, since the generated call
  carries the type argument on the receiver.
- Add `UnknownTransferable`, returned for a direct method result whose
  transferable tag has no known runtime binding, instead of untyped `dynamic`.

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
