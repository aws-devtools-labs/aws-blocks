---
"@aws-blocks/data-common": patch
"@aws-blocks/blocks": patch
---

Polish the PGlite init-retry helper (`data-common`) following #205 review:

- Narrow the WASM-trap classifier to specific signatures (`RuntimeError: unreachable`, `wasm trap: unreachable`, Emscripten `Aborted(<reason>)`) instead of matching the bare word `unreachable`, so an unrelated probe failure whose text/stack merely contains "unreachable" (e.g. an `assertUnreachable` helper) is no longer misclassified as retryable. The `Aborted(` prefix (not just the empty `Aborted()`) is matched so memory-pressure aborts like `Aborted(Cannot enlarge memory arrays)` / `Aborted(OOM)` — the case this retry exists for — are caught.
- Classify retryability BEFORE consulting the attempt budget in `initializePgliteWithRetry`, so instance cleanup is uniform (a non-retryable error is always rethrown untouched) and `maxAttempts === 1` no longer closes the instance on a non-trap failure.
- Guard `maxAttempts` against `NaN` (which `?? 3` does not default), preventing an unbounded close/recreate loop on a persistent trap.
- Wrap a `recreate()` failure so the original init trap is preserved as the error `cause`, keeping debugging pointed at "PGlite kept trapping" rather than only the secondary recreate error.
- Mark the four init-retry exports (`initializePgliteWithRetry`, `isPgliteUnreachableTrap`, `PgliteLike`, `PgliteInitRetryOptions`) `@internal` — they exist only so the engine packages can share the helper — and document the `PgliteLike` methods.
