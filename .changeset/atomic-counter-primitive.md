---
"@aws-blocks/bb-distributed-data": minor
---

Add an atomic `Counter` primitive to `DistributedDatabase`. `db.counter(name).next()` returns a race-free monotonic sequence value (with `.current()` and `.reset()`), backed by a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` upsert against a framework-managed `_blocks_counters` table (created automatically on deploy). This replaces the racy `SELECT MAX(seq) + 1` read-modify-write pattern that DSQL otherwise forces, since it has no sequences (`SERIAL` / `BIGSERIAL`).
