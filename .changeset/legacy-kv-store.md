---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
---

feat(bb-kv-store): `LegacyKVStore` reads the store of release 0.4.0 or earlier, for an upgrade

A release up to 0.4.0 keeps each item as `{ pk, value, ttl }`. This release keeps one attribute for each field under another key attribute, and DynamoDB cannot change the key of a table. So a `KVStore` of this release cannot take over the table of such a store: the deploy fails, and the table keeps its items.

`LegacyKVStore` is the store of such a release, for the time of the upgrade. Change the class on the line of the old store, keep its id and its options, and add a `KVStore` with a new id:

```ts
// Release 0.4.0: const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
```

The deploy does not change the old table. `LegacyKVStore` has `get`, `scan`, and `delete`, and it does not write. Copy the items in your own code, with `scan` of the old store and `put` with `ifNotExists` into the new one. Then remove the `LegacyKVStore` and deploy: the old table leaves the stack, by its removal policy.

The README section "Upgrade from release 0.4.0 or earlier" has the steps and what to know before you start.
