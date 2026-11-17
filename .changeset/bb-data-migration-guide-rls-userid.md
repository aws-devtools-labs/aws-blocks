---
'@aws-blocks/bb-data': patch
'@aws-blocks/blocks': patch
---

The `MIGRATION_GUIDE.md` that `bb-data pull` generates for Supabase apps now says which token must carry the non-standard JWT claims your RLS policies read: the one `Auth` verifies, which is the ID token for browser sessions and the access token for `Authorization: Bearer` API callers (it said the access token only).
