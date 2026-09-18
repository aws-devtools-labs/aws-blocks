---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
---

fix(bb-kv-store): align `delete()` conditional detection with the mock and `put()`

The AWS `delete()` path detected the value-equality condition with
`'ifValueEquals' in conditions` (key presence), while the mock and AWS `put()`
use `!== undefined`. Two consequences, both mock↔AWS parity breaks:

- `delete(key, { ifValueEquals: undefined })` was a silent no-op on the mock but,
  on AWS, emitted `#value = :expected` with `:expected = JSON.stringify(undefined)`
  (`undefined`) — a DynamoDB DocumentClient marshalling error instead of an
  unconditional delete.
- The `if/else if` applied only `attribute_exists(#pk)` when both `ifExists` and
  `ifValueEquals` were set, silently dropping the value check — so on AWS the
  item was deleted regardless of its value, while the mock (correctly) required
  both.

`delete()` conditions are now composed conjunctively (`attribute_exists(#pk) AND
#value = :expected`) with `!== undefined` detection, matching the mock branch-for-
branch. Added `parity.test.ts` cases asserting the `DeleteCommand` shape for each
combination (value-only, exists-only, both, none, explicit `undefined` no-op, and
`null` as a real condition).
