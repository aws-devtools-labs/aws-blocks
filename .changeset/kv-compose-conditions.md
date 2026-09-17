---
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/blocks": patch
---

`KVStore.put`: allow `ifNotExists` and `ifValueEquals` to compose.

Previously the two conditional-write options were mutually exclusive — the AWS runtime silently ignored `ifValueEquals` when `ifNotExists` was also set, and the mock rejected the write outright, so passing both was unusable (and the two layers diverged). They now compose with **OR**: the write succeeds when the key is absent **or** its current value matches, and fails only when the key exists **and** the value differs. This is the optimistic "create it, or update it only if unchanged" pattern (`attribute_not_exists(pk) OR value = :expected`). Each option used alone is unchanged.
