---
"@aws-blocks/bb-database": minor
---

`Database.transaction(fn, { retryOnConflict: true })` now waits before each re-run of the callback, and the default `maxRetries` is 8 instead of 3. The wait is a random time between 0 and a ceiling. The ceiling is 50 ms for the first retry, doubles with each retry and stops at 2,000 ms. Before, the retries ran with no wait, so transactions that conflicted on one row re-ran together and conflicted again. Measured on 2026-11-15 against real clusters in us-east-1, with 10 concurrent read-modify-write transactions on one row of a `dsql` cluster: 52% still failed with `SerializationFailure` after 3 retries with no wait, and 0 of 425 failed with the new wait and default, with up to 50 concurrent writers.

With the default, the waits add up to 7.15 seconds at most; pass a smaller `maxRetries` when the caller cannot wait that long. An explicit `maxRetries` keeps its meaning. Local mode and AWS behave the same. The retries of a single `query` or `execute` outside a transaction are unchanged.

`transaction()` has a new option, `signal`. When the signal is aborted, the block does not wait or re-run the callback again. Pass `context.request.signal` in an API method so that a retry cannot commit after the request deadline. A `maxRetries` that is not a whole number of 0 or more now throws `DatabaseConfigurationError`; before, such a value turned the retries off without a message.
