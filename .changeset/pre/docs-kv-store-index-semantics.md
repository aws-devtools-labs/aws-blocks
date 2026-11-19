---
'@aws-cdk-blocks/bb-kv-store': patch
---

docs: say what a KVStore index returns and how a `null` indexed field behaves

The README "Indexes" section and DESIGN.md now state that an index query returns whole items (every index the block creates projects all attributes; a `fromExisting` table keeps its own indexes), and that DynamoDB rejects a `put` whose indexed field holds `null` or a value of the other type with a `ValidationException`, while the local mock accepts the write. The mock-versus-AWS table in DESIGN.md lists that difference, including when such an item still appears in a local index query.
