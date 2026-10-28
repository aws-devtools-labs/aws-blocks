---
"@aws-blocks/create-blocks-app": patch
---

The `AGENTS.md` that `create-blocks-app` adds to every new app now covers live data. It recommends `Realtime` for pushing updates, and gives rules and a typed snippet for polling safely: one call in flight at a time (a `setTimeout` chain, never a fixed `setInterval`), a pause while the tab is hidden with an immediate refresh when it's visible again, one call per tick, backoff on errors, and a stop function that drops late responses.
