# f_831fa7d8 — mock/AWS parity: malformed refreshed descriptor (PR #503)

Worktree: `/local/home/msober/aws-blocks-token-refresh` (branch `fix/realtime-token-refresh`, HEAD 639d28a).
Scope: source + test in `bb-realtime` only. Not committed/pushed. `aws-middleware.ts`, `bb-agent/transport.ts`, and `DESIGN.md` untouched.

## Problem
In `mock-middleware.ts`, the reconnect `refresh()` resolve continuation applied a fresh token
only when the descriptor was valid, but ALWAYS fell through to `openMockSocket(...)`. A
malformed/tokenless refresh result therefore silently reopened + resubscribed with the STALE
stored token. `aws-middleware.ts` instead takes a failure path when `applyFreshDescriptor`
returns false (`onDisconnect('error')` + `scheduleReconnect` + return, no reopen). The mock
divergence defeated T4 (mock must reproduce the runtime error path).

## Fix — packages/bb-realtime/src/mock-middleware.ts (resolve continuation, ~L114-129)
Inverted the guard: when `!(isRealtimeDescriptor(fresh) && typeof fresh.token === 'string')`,
fire `c.disconnectHandlers` with `'error'`, call `scheduleReconnect(wsUrl)`, and `return` —
no reopen. Only a valid descriptor sets the channel token and calls `openMockSocket`. Fires on
`c` (the re-fetched pooled connection from the teardown guard). Mirrors the idiom already used
by the `.catch()` block directly below. Teardown-guard comment above preserved; Biome style
(tabs/single quotes/semicolons); cast-free.

## Test — packages/bb-realtime/src/reconnect.test.ts
Added `mock refresh resolving a malformed descriptor does not open a socket with stale tokens;
surfaces error + backoff` in the `Mock (local-dev) middleware: token refresh on reconnect`
suite, mirroring the AWS test of the same intent. Harness matches the sibling mock
refresh-on-reconnect test: `mockHydrate` + `isChannelClient`, install `refresh` returning a
malformed `{ __blocks: 'realtime/channel', channel: CHANNEL }` (no wsUrl/token — cast-free,
satisfies the descriptor param type), drop via `emitServerClose(1006)`, flush microtasks.

Assertions: refresh called once; `FakeWebSocket.instances.length === 1` (no stale-token
reopen); `errorDisconnects === 1`; refresh retried on the next backoff tick.

Parity note: expected `errorDisconnects` is 1 for the mock (vs 2 in the AWS test). The mock's
`onclose` reports every drop as `'unknown'` (it deliberately does not classify the close code),
so only the malformed-refresh failure path contributes an `'error'`. The AWS `onclose` maps
1006→`'error'`, giving it two. Documented inline in the test.

## Verify
- Repo root: `npm run generate:sources && npx tsc --build` → PASS.
- `packages/bb-realtime` `npm test` → tests 110, pass 110, fail 0. Both malformed tests pass
  (AWS `refresh resolving a malformed descriptor…` and the new mock mirror).
- `packages/bb-agent` `npm test` → pass 145+4+1+2, fail 0 (no CannotFindAsset failures surfaced
  this run; none unrelated to ignore).
