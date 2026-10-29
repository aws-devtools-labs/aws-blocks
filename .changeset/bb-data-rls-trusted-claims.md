---
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": minor
---

**Breaking (behavior):** `withRLS({ userId, role, claims })` no longer lets `claims` override `sub` or `role` in `request.jwt.claims`. `sub` always comes from `userId` and `role` from `role`, so an RLS policy that reads either claim sees the server-derived value. Any other claims still pass through.

If you relied on `claims.sub` or `claims.role` to change those values, pass the intended value as `userId` or `role`, or put it under a different claim name.
