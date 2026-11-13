---
"@aws-blocks/bb-secret": patch
---

The `Secret` README now has a complete example of a key the app generates and rotates itself:

- **One secret:** a single `Secret` with `{ generate: true, allowRuntimeWrite: true }`.
- **Scheduled rotation:** a `CronJob` rotates the key with `put()`, so no public API method is needed.
- **Verification:** an HMAC check accepts signatures made with the current key, or with the previous key read through `get({ version: 'previous' })` during the grace window.

The README recommends keeping the old key as that previous version instead of packing current and previous keys into one JSON value or copying them to another store.

The Local development section now explains that the mock re-reads `.bb-data/settings.json` on every `get()`, which key a secret is stored under (`name`, else `fullId`), and how to seed or unset a value in a local test. The README also says that an unset value (`null`) is cached on AWS like any other value.
