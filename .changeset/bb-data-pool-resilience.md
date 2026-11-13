---
"@aws-blocks/bb-data": patch
---

fix(bb-data): keep external-database connections healthy after transient failures

Fixes for databases connected through `Database.fromExisting({ connectionString })` and `PgClientEngine`:

- A pooled connection closed by the server or network (a connection pooler's idle timeout, a network reset, a Lambda freeze/thaw) no longer crashes the process, whether it was idle or in use by a transaction. The pool discards the broken connection and logs a warning, then opens a replacement when one is needed. A transaction on that connection fails.
- A transaction whose `BEGIN` fails now releases its connection. Previously each failed `BEGIN` held a pool slot, so later queries could wait until the function timed out.
- On AWS, a failed read of the connection string (for example a throttled parameter lookup) is no longer cached. The next call retries instead of every later call on the warm function failing. Concurrent first calls still share one read.
