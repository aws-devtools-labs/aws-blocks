---
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

`DistributedTable`: reconcile reads with the schema via a new `readValidation` mode (default `'coerce'`).

**Behavioral change to the read path (preview).** Writes always validated against `schema`, but reads (`get`, `getBatch`, `query`, `scan`) returned the raw stored value. After a schema change, a row written under the old schema no longer conformed to type `T`: a newly added field was absent from the read (so the value silently violated `T`, and a `.default()` was never applied or persisted on write-back), and a required-no-default field made the read-modify-write cycle (`get()` → mutate → `put()`) throw `ValidationFailed`.

Reads now reconcile stored items with the schema via `readValidation?: 'off' | 'coerce' | 'strict'`:

- **`'coerce'`** (default) — return the schema's coerced output (defaults filled, types narrowed) so legacy rows conform to `T` and round-trip cleanly. On a value that can't be coerced, return the raw value + log a warning — **never throws**.
- **`'strict'`** — throw `ValidationFailed` on any non-conforming item (opt-in; treats a mismatch as corruption).
- **`'off'`** — return the raw stored value with no validation (the previous default behavior).

```ts
const orders = new DistributedTable(scope, 'orders', {
  schema: orderSchemaV2,          // adds `currency: z.string().default('USD')`
  key: { partitionKey: 'orderId' },
  // readValidation: 'coerce' is the default
});
const order = await orders.get({ orderId: 'o1' }); // legacy row → currency: 'USD'
await orders.put({ ...order, total: 20 });          // conforms to T; round-trips
```

Migration note: the default is now `'coerce'` (previously reads returned raw values). Pass `readValidation: 'off'` to restore raw reads. Coercion is best-effort and validator-dependent — transform-bearing schemas (e.g. Zod) fill defaults and narrow types; check-only Standard Schema validators pass values through unchanged. `null` (a missing item) is untouched in all modes.
