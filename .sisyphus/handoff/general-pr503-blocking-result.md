# PR #503 — 3 BLOCKING findings fixed (one coherent `refresh` redesign)

Branch `fix/realtime-token-refresh`, base main `30c4eb1`, HEAD `d39ab96` (NOT committed/pushed). Tree builds green.

## B2 (4155697574) — per-channel refreshers (core)
**`packages/bb-realtime/src/aws-middleware.ts`**
- `Connection.refresh?` (single, last-writer-wins) → `refreshers: Map<string, () => Promise<RealtimeChannelDescriptor>>`. Initialized in `getOrCreateConnection`.
- `subscribeTo`: `conn.refreshers.set(channel, refresh)` when a refresh is provided.
- Deleted wherever the channel leaves `subscriptions`: unsubscribe of the channel's last handler; the onmessage resubscribe-rejection path; and `__resetConnectionsForTest` (`.clear()`).
- `openSocket` reconnect continuation rewritten: gather refreshers for channels STILL in `conn.subscriptions`; `Promise.allSettled` over them; each fulfilled, well-formed descriptor applied via `applyFreshDescriptor` (instance-scoped connectToken/wsUrl from any fulfilled one, per-channel token set); a rejected/malformed channel falls back to its stored token. All-failed ⇒ onDisconnect('error') + `scheduleReconnect`. Teardown guards (tornDown / pool-ownership / subscriptions.size) kept BEFORE and AFTER `applyFreshDescriptor`. No refresher at all ⇒ synchronous `constructSocket` (no-refresh back-compat unchanged).

**`packages/bb-realtime/src/mock-middleware.ts`** — mirrored: `refreshers` map; set/delete in the same spots; `doConnect` reconnect uses `allSettled` with the same shape; the mock's malformed-refresh failure path (`isRealtimeDescriptor && typeof token === 'string'`) now holds per-channel; all-failed ⇒ `disconnectHandlers.forEach('error')` + `scheduleReconnect`.

**`packages/bb-realtime/src/types.ts`** — `SubscribeOptions.refresh` signature UNCHANGED (`() => Promise<RealtimeChannelDescriptor>`); only its JSDoc note updated from "connection-level last-writer-wins" to the accurate per-channel description.

## B1 (4155697588) — channel-aware refresh in bb-agent
- `index.chat.ts` `CreateChatOptions.refresh` and `index.hooks.ts` `UseChatOptions.refresh` → `(channelId: string) => Promise<...Descriptor>` (public options only).
- Bound where the channel is known: createChat `startTurn` and useChat `ensureSubscribed` pass `refresh: options.refresh ? () => options.refresh!(channelId) : undefined`.
- `ChatSubscribeOptions.refresh`, transport `ChatTransport.subscribe` opts.refresh, and bb-realtime `SubscribeOptions.refresh` all STAY zero-arg (they receive the bound form / channel is fixed per subscription). `transport.ts` needed no change.
- JSDoc examples updated (index.hooks.ts L133 + L220 @example, index.chat.ts L98) to `async (channelId) => ({ ...(await api.agentGetRawDescriptor(channelId)), __blocks: 'realtime/channel' })`.
- `test-apps/comprehensive/src/index.ts` `createChatForConvo` refresh → channel-aware form (cast-free; `agentGetRawDescriptor(channelId: string)`).

## B3 (4155697597) — pool-ownership guard on the refresh-failure path
- In the redesigned `openSocket`, the all-failed `scheduleReconnect` sits AFTER the single top guard `if (conn.tornDown || connections.get(conn.wsUrl) !== conn || conn.subscriptions.size === 0) return;` (no separate unguarded `.catch` exists anymore — `allSettled` never rejects).
- `scheduleReconnect`: both `connections.delete(conn.wsUrl)` calls (subscriber-less branch and give-up branch) are now delete-by-identity: `if (connections.get(conn.wsUrl) === conn) connections.delete(conn.wsUrl);` so a stale conn can never evict the live owner of its wsUrl key.

## Tests added
- `reconnect.test.ts` (AWS fake-socket): scenario-2 (both live, each own refresh → both fresh), scenario-1 (B unsubscribed → refreshB NOT run, A re-mints own token), B3 pool-eviction repro (drop/unsub-A/sub-B/reject → C reuses B, no 3rd socket).
- `reconnect.test.ts` (mock): scenario-1 + scenario-2 mirrors.
- `index.test.ts`: rewrote the old "forwarded verbatim" useChat test to assert the bound channel-aware form; added useChat loadConversation('a')→('b') rebind test and createChat loadConversation-switch test (both assert refresh asked for channel 'b', not the first).

## B3 bobbor follow-ups (second pass — teardown-identity + mock parity)
Completed the bobbor sub-items the first pass missed:
- **aws-middleware `settleResubscribe` all-stale guard**: now sets `conn.tornDown = true` (the 5th deliberate-teardown path — the `tornDown` docstring enumeration was extended to list it) AND the pool drop is delete-by-identity (`if (connections.get(conn.wsUrl) === conn) connections.delete(conn.wsUrl);`). This was the 3rd delete-by-KEY site; the two scheduleReconnect branches were already identity-based.
- **mock-middleware refresh continuation guard**: now guards to the LIVE conn by IDENTITY (`!c || c !== conn || c.tornDown || c.subscriptions.size === 0`), mirroring AWS's `connections.get(conn.wsUrl) !== conn`, so a stale refresh settling after the wsUrl key was taken over by a different conn (reset + new subscribe) cannot fire disconnect('error') / scheduleReconnect against the live owner.
- **mock-middleware `scheduleReconnect`**: clears any already-armed `reconnectTimer` before assigning a new one (AWS already did this), so a stale timer can't fire a duplicate reconnect.
- **Test added** (`reconnect.test.ts`, mock block): mock eviction repro — drop, refresh held pending, `mockReset` (key freed + conn A torn down), new sub B on same wsUrl (socket 2), A's refresh rejects → assert NO 3rd socket and no spurious disconnect on B.

## Verification
- root `npm run generate:sources && npx tsc --build` → PASS (exit 0).
- `packages/bb-realtime npm test` → 116 tests, 116 pass, 0 fail (was 115; +1 mock eviction test).
- `packages/bb-agent npm test` → index.test.js 147/147, index.cdk.test.js 4/4 (the known CannotFindAsset tests actually PASSED here), agentcore-bundle 1/1, user-agent 2/2 → 154 pass, 0 fail.
- `test-apps/comprehensive npx tsc --noEmit` → PASS (exit 0), cast-free.
- No `as any` / `:any` / `@ts-ignore` / `as unknown` introduced. No commits/pushes.
