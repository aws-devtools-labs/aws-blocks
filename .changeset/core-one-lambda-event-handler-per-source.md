---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`Scope.registerLambdaEventHandler()` now throws, for every Building Block, when a handler is already registered for the same event source and identifier, instead of silently replacing the first one. This only fires on a misconfiguration: two blocks in your app consuming the same queue, schedule, WebSocket API or user pool trigger, or a block constructed per request (inside a handler) instead of once at module level. A correctly configured app is unaffected; a misconfigured one now gets an error naming the duplicate, where before one block quietly took over the other's events.
