---
'@aws-blocks/bb-auth': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/blocks': patch
---

`Auth`'s signed-in user (`AuthenticatedUser`) has an optional `claims` field: the provider's verified claims for users who sign in through an `oidcProviders` entry with `federateVia: 'direct'` (the default), as `AuthOIDC`'s user carried. With `db.crud()` or `db pull`'s `supabaseCrud()` and Postgres row-level security, RLS therefore sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`, so policies that match the raw `sub` keep returning rows after the move to `Auth`. `claims` is absent for user-pool users, whose RLS subject is their `userId`. `claims` is server-side only: `getAuthState()` and the sign-in routes never send it to the browser.

`@aws-blocks/bb-data`: newly generated `supabaseCrud()` wiring now passes `claims` to RLS explicitly, and the generated `MIGRATION_GUIDE.md` now says which subject RLS sees for each kind of user.
