# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- FileBucket — actually stores, serves and deletes the uploaded bytes (not just lists names). Expect `bucket.put(path, body)` on upload, `bucket.getUrl(path)` for the real download link, and `bucket.delete(path)` on delete.
