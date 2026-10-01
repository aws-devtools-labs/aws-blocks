# PR #503 bb-realtime robustness — result

Worktree `/local/home/msober/aws-blocks-token-refresh` (branch `fix/realtime-token-refresh`, HEAD 967f767). **Not committed, not pushed.** Only `packages/bb-realtime/src/{aws-middleware.ts,mock-middleware.ts,reconnect.test.ts}` touched.

## Finding 1 — channel-membership validation
A fulfilled refresh whose descriptor is for a different channel than the one it was fetched for (short conversationId instead of the full `{fullId}/chunks/{id}` path, or another conversation) previously stored a token under a dead/foreign key → real channel silently replays its stale token.

- **aws-middleware.ts** `applyFreshDescriptor` now takes `expectedChannel` and returns `false` on `fresh.channel !== expectedChannel || !conn.subscriptions.has(fresh.channel)` (checked right after the `isRealtimeDescriptor` guard, before any token write / pool re-key). Docstring extended. Call site in `openSocket` switched to an index loop so `channelsToRefresh[i]` (positionally aligned with `results[i]`) is passed as `expectedChannel`.
- **mock-middleware.ts** `doConnect` apply loop made index-based with the same `result.value.channel === channelsToRefresh[i] && c.subscriptions.has(...)` guard inline (mock has no `applyFreshDescriptor` fn). A mismatch counts toward all-failed → `onDisconnect('error')` + `scheduleReconnect`.

## Finding 2 — bound refresh() with a timeout
A never-settling refresh at reconnect time left the conn `connected=false`, no socket, no reconnect timer → wedged forever.

- Added `const REFRESH_TIMEOUT_MS = 15_000;` next to `MAX_DELAY_MS` in both files, with rationale comment.
- Added a `withRefreshTimeout(refreshing)` helper in both files: `Promise.race([refreshing, timeout])` where `timeout` is a `setTimeout`-reject; `.finally(() => clearTimeout(timer))` clears the handle whichever side wins (no dangling timer — `node --test` exits clean). Each refresher call in the `Promise.allSettled(...map(...))` is wrapped. A hung refresh becomes a per-channel rejection → existing rejected→fallback / all-failed→backoff path → `MAX_RECONNECT` cap applies.

Timer-handle typed `ReturnType<typeof setTimeout> | undefined` (cast-free; `clearTimeout(undefined)` is a no-op). Mock mirrors AWS.

## Tests (reconnect.test.ts)
Added test consts `REFRESH_TIMEOUT_MS`, `MAX_DELAY_MS`. Four new tests (aws + mock each):
- membership: subscribe `my-app-rt/conv-1/chunks/abc`, refresh resolves `{channel:'conv-1'}` → no socket reopens, failure surfaces via `onDisconnect('error')` (aws: 2 = drop+failure; mock: 1 = failure only, drop reported 'unknown'), refresh retried next backoff tick (not wedged, no stale replay).
- timeout: refresh returns `new Promise(()=>{})` → driven past the cap with `mock.timers`, asserts `refresh.callCount === MAX_RECONNECT` (retried, not wedged at 1) and no reconnect socket constructed.

## Verify
- `npm run generate:sources && npx tsc --build` → PASS (exit 0, no errors).
- `cd packages/bb-realtime && npm test` → **tests 120, pass 120, fail 0, cancelled 0** (116 prior + 4 new). Suite exits cleanly (exit 0, no dangling-timer hang). 967f767 per-channel + eviction (B2/B3) tests stay green.

## Constraints honored
Cast-free; docstrings/comments/logging preserved; Biome style (tabs/single-quotes/semicolons); mock mirrors AWS; timeout timer cleared on settle; no new deps; no `bb-agent`/`DESIGN.md`/`types.ts`/`.changeset` touched; no security-disclosure language.
