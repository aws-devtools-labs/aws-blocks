# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- EmailClient — sends the digest email (a local mock that writes the message to disk). Expect `email.send({ to, subject, body })`.
- CronJob — declares the recurring schedule; it has no runtime `submit()`/run method, so the declaration itself proves the recurring wiring. Expect `new CronJob(scope, id, { schedule: 'rate(...)', handler })`.
- KVStore — caches the last-sent `{ to, at }` metadata so it survives a reload. Expect `store.put('last-digest', ...)` and `store.get('last-digest')`.
