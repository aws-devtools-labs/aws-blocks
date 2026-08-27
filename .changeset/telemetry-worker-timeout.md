---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

fix(telemetry): stop the send worker aborting in-flight events at 500ms

The telemetry send worker gave the whole HTTPS POST — DNS, TCP connect, TLS
handshake, request body, and the wait for response headers — a single 500ms
socket budget with no retry. Whenever a cold round trip to
`blocks-telemetry.us-east-1.api.aws` ran past that, the worker destroyed a
request that was otherwise on its way to a `200`, logged
`BLOCKS-TELEMETRY: timed out`, and exited non-zero. The event was silently lost
in production, and in CI the `Telemetry E2E` suite — which asserts
`BLOCKS-TELEMETRY: sent (status=200)` at 15 call sites — failed on whichever
event happened to land in the latency tail, turning an unrelated PR red.

The 500ms value was carried over from the pre-#48 design, when the POST ran
in-process and the budget genuinely gated how long telemetry could keep the
CLI's event loop alive. Since #48 the send happens in a `detached` + `unref()`ed
subprocess, so the parent CLI has already returned before the request is in
flight and the budget no longer protects user-perceived latency — it only
decides whether the background process gives up before the endpoint answers.

The budget is now 5s in both workers (`@aws-blocks/core` and
`@aws-blocks/create-blocks-app`, which are kept byte-compatible by design). It
still bounds the background process so a hung endpoint can't leave it
lingering, but it no longer discards events that just needed a normal cold
connection. Nothing about the request itself changed, telemetry remains
fire-and-forget, and command latency and exit codes are unaffected.
