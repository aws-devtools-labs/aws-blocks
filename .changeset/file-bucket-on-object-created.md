---
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/blocks": minor
---

feat(bb-file-bucket): run a handler when an object is created (`onObjectCreated`)

`FileBucket` takes a new `onObjectCreated: { prefix?, suffix?, handler }` option. The handler runs in the background after an object lands in the bucket, including uploads that go straight to S3 through `putUrl()` or `createUploadHandle()`, `restoreVersion()`, and writes by any other client. It receives `{ path, size, versionId }`; `versionId` is set on versioned buckets (the default) and absent with `versioned: false`.

- On AWS, S3 sends `ObjectCreated` notifications, filtered by `prefix`/`suffix`, to a dedicated SQS queue that the backend's compute consumes, as it does for an `AsyncJob`. A handler that throws is retried, up to 3 attempts in total, and the event then moves to a dead-letter queue.
- Locally, every matching write runs the handler asynchronously, with the same retry count.
- Delivery is at least once and unordered: handlers must tolerate duplicates and reordering. The README shows reading the notified version with `get(path, { versionId })` and keying outputs by path and version.
- Not supported on a bucket wrapped with `FileBucket.fromExisting`; that combination fails synth and the local mock.

Buckets without `onObjectCreated` provision nothing new. `@aws-blocks/bb-file-bucket` now depends on `@aws-blocks/bb-async-job`. `@aws-blocks/blocks` re-exports `ObjectCreatedOptions`, `ObjectCreatedEvent` and `ObjectCreatedContext`.
