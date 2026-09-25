---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

fix(bb-file-bucket): align unknown-`versionId` behavior between the mock and AWS

On a versioned bucket, an unknown `versionId` diverged between runtimes. S3 does
**not** signal an unknown `versionId` as `NoSuchVersion` (verified against real
S3): an id it cannot resolve comes back as `InvalidArgument` ("Invalid version id
specified") on `GetObject`/`DeleteObject` and `InvalidRequest` on `CopyObject`;
`NoSuchVersion` is reserved for a well-formed id that no longer exists. The AWS
runtime now normalizes all of these so the observable contract matches the mock:

- `get()` — returns `null` for an unknown `versionId` (matching the mock and
  `get()`'s documented "null if it does not exist" contract), instead of throwing.
- `delete()` — is a silent no-op for an unknown `versionId` (matching the mock),
  instead of throwing.
- `restoreVersion()` — throws a clean, matchable `FileBucketErrors.VersionNotFound`
  (`NoSuchVersion`) via core's `blocksError` producer, so both `.name`
  (`isBlocksError(e, FileBucketErrors.VersionNotFound)`) and the `.message` agree
  across runtimes — instead of the raw S3 error, whose enumerable `$metadata`
  (request IDs, ARNs) would leak to the client on serialization.

The raw S3 codes are folded only when a `versionId` was actually supplied, so an
unrelated `InvalidArgument`/`InvalidRequest` still surfaces. Also adds the public
`FileBucketErrors.VersionNotFound` constant, and encodes the caller-supplied
`versionId` in `CopySource` (a value with `&`, `#`, `?`, or a space would
otherwise corrupt the `x-amz-copy-source` header).
