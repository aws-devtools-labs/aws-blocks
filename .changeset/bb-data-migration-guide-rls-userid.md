---
'@aws-blocks/bb-data': patch
'@aws-blocks/blocks': patch
---

The `MIGRATION_GUIDE.md` that `bb-data pull` generates for Supabase apps now says that RLS sees the issuer-prefixed `userId` (`${iss}:${sub}`, the value auth Building Blocks return as `user.userId`), not the identity provider's raw `sub`. It shows how to migrate existing `user_id` columns to that format, how to keep raw ids with an `idp_sub` claim instead, and that non-reserved claims such as `email` still reach `request.jwt.claims`.
