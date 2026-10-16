---
"@aws-blocks/bb-secret": minor
"@aws-blocks/blocks": minor
---

feat(bb-secret): make `Secret` read-only at runtime by default; add `allowRuntimeWrite`

A `Secret` is now **read-only at runtime unless you opt in**. By default the instantiated object exposes only `get()` and `listVersions()` — there is no `put()` method (a call is a compile error *and* the method is absent from the object at runtime), and the deployed execution role is granted **read-only** IAM (`GetSecretValue` + `ListSecretVersionIds`, no `PutSecretValue`). This is the least-privilege default: most apps read a credential that is set out-of-band (console / `aws` CLI / CI), so the running app never needs write access.

Pass the new `allowRuntimeWrite: true` option to opt into runtime writes — then `put()` is present on the object and the execution role is granted `PutSecretValue`. The option applies to every secret, including one wrapped via `Secret.fromExisting(arn)`.

```typescript
// Read-only (default): no put(); role gets read-only IAM.
const stripeKey = new Secret(scope, 'stripe-api-key');
const key = await stripeKey.get();

// Writable: the app sets/rotates the value itself.
const token = new Secret(scope, 'self-rotating-token', { allowRuntimeWrite: true });
await token.put('t-abc123');
```

**Behavioral/typing change (bb-secret is pre-1.0).** `Secret` is now exposed as an overloaded constructor whose return type reflects `allowRuntimeWrite`: `true` yields a `WritableSecret<T>` (has `put`), otherwise the read-only `Secret<T>`. Existing code that called `put()` on a default secret must now pass `allowRuntimeWrite: true`. Deployed stacks created before this change that relied on the runtime writing the secret will lose `PutSecretValue` until the declaration sets `allowRuntimeWrite: true` — add it where the app genuinely writes.
