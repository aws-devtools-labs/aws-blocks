---
"@aws-blocks/bb-secret": patch
---

The `Secret` README now shows a complete key the app generates and rotates itself: one `Secret` with `{ generate: true, allowRuntimeWrite: true }`, rotated with `put()`, with the replaced key read back through `get({ version: 'previous' })` during the grace window. It recommends keeping the old key as that previous version instead of packing current and previous keys into one JSON value or copying them to another store. The Local development section now explains that the mock re-reads `.bb-data/settings.json` on every `get()`, which key a secret is stored under (`name`, else `fullId`), and how to seed or unset a value in a local test.
