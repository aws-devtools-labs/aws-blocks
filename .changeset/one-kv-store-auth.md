---
"@aws-blocks/bb-auth-basic": major
"@aws-blocks/bb-auth-cognito": major
"@aws-blocks/bb-auth-oidc": major
---

refactor(auth): adopt the new `KVStore` item layout for the user, code and session tables

The three auth blocks follow `@aws-blocks/bb-kv-store` to its new major version. Their public APIs do not change. Their DynamoDB tables do: the partition key attribute is now `_bkv_pk` (was `pk`), object records are stored as flat attributes, and DynamoDB TTL is always enabled (`AuthBasic` and `AuthCognito` no longer pass `ttl: true`; `AuthCognito` maps `removalPolicy` onto the store's `protection`). Compare-and-swap writes on session records use `ifFieldEquals` instead of a whole-value compare. Reads of a single record (`KVStore.get`) are now strongly consistent, so in `AuthBasic` a request that starts after `signOut` or a password reset sees the revocation on every Lambda instance; these reads use twice the read capacity.

A deployed stack cannot update these tables in place, because a DynamoDB key schema cannot change and the tables have fixed names. For a sandbox, destroy the stack and deploy again. For a production stack, deploy the auth block under a new id (users and sessions sign in again) or copy the items to the new tables before switching.
