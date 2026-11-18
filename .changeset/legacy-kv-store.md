---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
---

feat(bb-kv-store): `LegacyKVStore` is the store of release 0.4.0 or earlier, for an upgrade

A release up to 0.4.0 keeps each item as `{ pk, value, ttl }`. This release keeps one attribute for each field under another key attribute, and DynamoDB cannot change the key of a table. So a `KVStore` of this release cannot take over the table of such a store: the deploy fails, and the table keeps its items.

`LegacyKVStore` is the store of such a release, for the time of the upgrade. Change the class on the line of the old store, keep its id and its options, and add a `KVStore` with a new id:

```ts
// Release 0.4.0: const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
```

The deploy does not change the old table. `LegacyKVStore` has the data methods of that store, `get`, `put`, `delete`, and `scan`, so the code that calls the store runs as before. Migrate the data to the new store however is appropriate for your app. A copy is a `scan` of the old store, which gives each entry with its expiry, and a `put` into the new one. Then remove the `LegacyKVStore` and deploy: the old table leaves the stack, by its removal policy.

`LegacyKVStore` is deprecated and frozen. It has the `@deprecated` tag, so an editor marks each use. It has the API of release 0.4.0 and gets no new features. Use it only for this upgrade, and remove it when the copy is done.

The README section "Upgrade from release 0.4.0 or earlier" has the steps and what to know before you start. The guide `docs/guides/upgrading-older-apps.md` starts from the CloudFormation error.
