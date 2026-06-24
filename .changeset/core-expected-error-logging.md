---
"@aws-blocks/core": patch
---

fix(core): don't dump full stack traces for expected typed errors

The dev server's RPC error logger and the Lambda handler's catch block both
unconditionally printed the full multi-line stack trace for every error. For
expected, typed Blocks errors (e.g. `KnowledgeBaseNotReadyException`,
`ConditionalCheckFailedException`, `ApiError`) the name + message already
carry all the signal, so the stack is noise.

A new conservative helper `isExpectedBlocksError(e)` is exported from
`@aws-blocks/core`. It treats an error as expected only when it is an `Error`
instance whose `name` follows the Blocks convention — a non-native name ending
in `Exception` or `Error`. Plain `Error`, native subclasses like `TypeError`,
and unnamed throws are still treated as unexpected and keep their full stack
so genuine bugs remain debuggable. `BLOCKS_DEV_QUIET` behavior is unchanged.
