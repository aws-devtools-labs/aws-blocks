---
'@aws-blocks/bb-data': patch
'@aws-blocks/blocks': patch
---

`db pull`'s generated `MIGRATION_GUIDE.md` and the auth placeholder it adds to your `index.ts` now use `Auth` from `@aws-blocks/bb-auth` instead of the removed `AuthOIDC`. The guide's example signs users in with Google as a directly federated OIDC provider, so their `userId` keeps the same `<issuer>:<sub>` format `AuthOIDC` produced, and the deploy checklist names the callback URL to register (`https://<your domain>/aws-blocks/auth/callback`).
