---
"@aws-blocks/core": patch
---

fix(core): an optional argument that the client leaves out stays absent on the server

The RPC client no longer sends trailing `undefined` arguments. JSON has no `undefined`, so `api.list(2)` on a method `list(limit, cursor?)` reached the server as `list(2, null)`: a default parameter value did not apply, and the method saw `null` where its type says `undefined`. The client now leaves trailing `undefined` arguments out of `params`, so the server calls the method with the arguments the caller passed.

An `undefined` before a later argument still arrives as `null`, because the later argument must keep its position. An explicit `null` is sent as before.
