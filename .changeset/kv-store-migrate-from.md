---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
---

feat(bb-kv-store): `migrateFrom` moves the items of a store of release 0.4.0 or earlier into a new store at deploy

A release up to 0.4.0 keeps each item as `{ pk, value, ttl }`. This release keeps one attribute for each field under another key attribute, and DynamoDB cannot change the key of a table. So a deploy of this release over such a table fails, and the table keeps its items.

`migrateFrom` is the path for those stores. Give the store a new id and name the old one:

```ts
// Release 0.4.0: new KVStore<Prefs>(scope, 'prefs', { ttl: true })
const prefs = new KVStore<Prefs>(scope, 'prefs-v2', {
  migrateFrom: { id: 'prefs', ttl: true },
});
```

The next deploy creates the new table, copies every item while the app runs, updates the app, and follows the old table for 45 seconds more. Remove the option and deploy again: the old table then leaves the stack, by its removal policy. Restate in `migrateFrom` the options that the old store had (`ttl`, `removalPolicy`, `deletionProtection`, `pointInTimeRecovery`, `encryption`).

The README section "Upgrade a store of an earlier release" has the steps, the cost, and what the move cannot guarantee. The local mock needs no step: it copies the data file of the old store on the first start.
