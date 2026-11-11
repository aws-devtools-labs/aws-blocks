---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-email-client": patch
---

fix: stop sending raw backend error text to clients

Several Building Blocks passed the raw text of an unexpected error (an AWS SDK, database, storage or hook error, which can name account ids, role and resource ARNs, and request details) to the client. They now follow the same rule as the RPC serializer: the message of an `ApiError` or a branded Building Block error (`blocksError()` / `brandBlocksError()`) still reaches the client unchanged, and any other error is logged server-side and reported as `Internal error`.

- **bb-agent:** when a turn fails, the `error` chunk, the persisted `metadata.error`, and the `StreamFailed` error from `complete()` carry `Internal error` unless the failure is a branded Building Block error. A malformed or invalid canned-responses dictionary (the local `canned` provider) now fails with a branded `InvalidModelConfigException` on the server, so its fixed message, e.g. `InvalidModelConfigException: Malformed canned responses JSON in 'responses.json'.`, reaches the client; it names the file by basename only and never quotes its contents, and the parser's detail is logged server-side. `complete()` still rejects with `StreamFailed` for it. Conversations persisted before this change keep the `metadata.error` text they were saved with, and `getConversation()` still returns it.
- **bb-email-client:** `send()` errors have stable messages per `EmailErrors` code, and a failed `sendBatch()` entry reports the error code or SES entry status instead of the raw SES text. The SES error is logged and kept on the error's non-enumerable `cause`.
