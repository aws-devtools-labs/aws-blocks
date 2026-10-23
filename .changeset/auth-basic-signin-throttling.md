---
"@aws-blocks/bb-auth-basic": minor
"@aws-blocks/blocks": patch
---

AuthBasic can now lock an account after too many consecutive failed sign-ins,
an opt-in defense against credential-stuffing and password brute-forcing (issue
#766). Pass the new `lockout` policy to enable it:

```typescript
const auth = new AuthBasic(scope, 'auth', {
  lockout: { maxAttempts: 5, windowSeconds: 900, lockoutSeconds: 900 },
});
```

Failed attempts are counted **per username** in the existing `codes` store
(under a `lockout:<username>` key, with a TTL so counters self-reap and never
grow unbounded). Once `maxAttempts` consecutive failures accumulate within
`windowSeconds`, the account is locked for `lockoutSeconds`; the lock is
enforced at the **top of `signIn`**, before the user record is read or the
password compared, so a locked account sheds the bcrypt cost under attack and
exposes no timing oracle. A successful sign-in clears the counter.

This is a `minor` (not `patch`) bump because it adds the exported error constant
`AuthBasicErrors.AccountLocked` (`AccountLockedException`, 429, branded so the
name crosses the wire) and the new `lockout` option (`LockoutPolicy`) on
`AuthBasicOptions`. The error message is generic — it reveals neither the
username nor any SDK metadata — and `retriable` is left `false` (a lockout
requires waiting out the window, not an immediate retry).

Throttling is **disabled unless `lockout` is passed**, so existing apps are
unaffected. This is per-account credential-guess protection, complementary to —
not a replacement for — infrastructure-layer rate limiting (CloudFront WAF, API
Gateway throttling) for volumetric/DDoS protection.

Per-username counting (rather than per-IP) matches `AuthCognito`'s managed
lockout and avoids locking out a whole shared NAT/corporate egress on one user's
typos. The umbrella `@aws-blocks/blocks` is bumped because the bundled
`bb-auth-basic` README/DESIGN docs it mirrors have changed.
