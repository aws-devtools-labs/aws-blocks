---
"@aws-blocks/bb-auth": minor
---

feat(bb-auth): the session store has a new table, on the new `KVStore` layout

`Auth` follows `@aws-blocks/bb-kv-store` to its new version. Its public API does not change.

- **The session store is a new table, `<fullId>-session-store`.** `AuthCognito` and `AuthOIDC` kept their sessions in `<fullId>-sessions`. The new `KVStore` stores an item under another key attribute (`_bkv_pk`, was `pk`) and keeps the expiry in `_bkv_ttl` (was `ttl`), and a DynamoDB table cannot change its key. So the store has a new child id, `session-store`, and an upgrade is one successful deploy: CloudFormation creates the new table and removes the old one from the stack.
- **The old `sessions` table** is deleted when its removal policy is `destroy`, and is left in the account, outside the stack, when it is `retain`. A table that is left behind still holds the session rows until they expire; delete it when the upgrade is done (see "The session store" in `MIGRATION.md`).
- **Every user signs in once.** Nothing reads the old table. A session cookie from before the upgrade gets the signed-out answer (`getCurrentUser()` returns `null`, `requireAuth()` throws 401 `NotAuthenticatedException`) and is cleared; it is never an error. The user pool, the app client, the users and the cookie name do not change. The session secret follows `defaults.secretsStore`; a stack that keeps it in SSM keeps the key, not the sessions.
- Local development is the same clean break: the mock keeps the sessions in `.bb-data/<fullId>-session-store/` and does not read the old directory.
- A session row has a numeric `version` that each write increments. A refresh, or a refresh that the identity provider rejects, writes on the condition that the version is the one it read, in place of a compare of the whole row.
- `removalPolicy` and `deletionProtection` map onto the one `protection` setting of the store for the session table: retained and protected when deletion protection resolves to on, retained when it resolves to off with `'retain'`, deleted with the stack when it resolves to off with `'destroy'`. With neither option set, the table follows the stack defaults, as before.
- `auth.admin.revokeUserSessions` deletes the sessions of a user with one batch call. On AWS the call can fail with the store's `BatchIncompleteException` when DynamoDB leaves entries unprocessed; call it again.
