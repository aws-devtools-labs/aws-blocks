---
"@aws-blocks/bb-auth": minor
---

feat(bb-auth): the session store uses the new `KVStore` layout

`Auth` follows `@aws-blocks/bb-kv-store` to its new version. Its public API does not change.

- The `sessions` table changes: the partition key attribute is `_bkv_pk` (was `pk`), each field of a session record is one attribute, and the expiry is in `_bkv_ttl` (was `ttl`). DynamoDB TTL is always on.
- **A deployed stack cannot update the `sessions` table in place.** A key change is a replacement, and CloudFormation does not replace a table that has a fixed name. The first deploy over a stack that an earlier release deployed (with `AuthCognito` or `AuthOIDC`) fails and rolls back until the old `sessions` table is out of the stack. For a sandbox, destroy the stack and deploy again. For a stack whose user pool you must keep, remove the old table from the stack first; see "The `sessions` table" in `MIGRATION.md`. The table holds only sessions: users sign in once more, and the user pool is not affected.
- A session row has a numeric `version` that each write increments. A refresh, or a refresh that the identity provider rejects, writes on the condition that the version is the one it read, in place of a compare of the whole row.
- `removalPolicy` and `deletionProtection` map onto the one `protection` setting of the store for the session table: retained and protected when deletion protection resolves to on, retained when it resolves to off with `'retain'`, deleted with the stack when it resolves to off with `'destroy'`. With neither option set, the table follows the stack defaults, as before.
- `auth.admin.revokeUserSessions` deletes the sessions of a user with one batch call. On AWS the call can fail with the store's `BatchIncompleteException` when DynamoDB leaves entries unprocessed; call it again.
- Local development: the mock converts the session file of an earlier release, so local users stay signed in.
