---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Sanitize RawRoute uncaught exceptions so raw driver/SDK details no longer leak.

A RawRoute whose handler throws an uncaught exception previously forwarded that error's raw name and message to the client, the same leak class the RPC path was already fixed for. The RawRoute catch (both the deployed `lambda-handler` and the local `dev-server` paths) now runs the caught throw through core's shared sanitizer: a Building Block or `ApiError` keeps its BB-authored name and message, and everything else — a driver/SDK exception or a bare `Error` — collapses to a generic `500` / `"Internal error"`, with the full error still logged server-side. A handler's own deliberate `ctx.response` writes are untouched; only the uncaught-exception path is sanitized.

Two small behavior notes: a RawRoute uncaught exception that previously forwarded its raw name/message now returns a generic 500, and an `ApiError` built with the default name no longer emits `name: "ApiError"` on the wire (status is detected via `isApiErrorLike`, not a name compare).
