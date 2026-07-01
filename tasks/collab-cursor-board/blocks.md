# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- Realtime — broadcasts presence changes to every other open tab without a manual refresh. Expect `rt.publish(namespace, channel, data)` on join and `rt.subscribe(namespace, channel, handler)` on the client.
- DistributedTable — persists the shared roster so it survives a reload and is present on first paint. Expect `table.put(item)` and a read (`table.scan()` / `table.query(...)`).
