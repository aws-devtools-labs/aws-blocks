---
"@aws-blocks/admin-ui": patch
---

The data browser reads the `KVStore` data file of this release (`.bb-data/<fullId>/store.json`, `{ "version": 2, "items": [...] }`): the string key or the declared key fields, the value, and an expiry that the store keeps outside the value. Local record writes work on that file for a store with declared key fields, and keep the key and the expiry of the record they replace. A store directory that has both `store.json` and `data.json` is read from `store.json`, as the `KVStore` mock does. The session store of `Auth` (`<fullId>-session-store`) sorts with the other auth stores.
