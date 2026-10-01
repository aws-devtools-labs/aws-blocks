# Thread `refresh` through realtimeTransport + createChat

Branch `fix/realtime-token-refresh` (worktree `/local/home/msober/aws-blocks-token-refresh`).
No commit/push. bb-realtime source untouched.

## Files changed (3)

### 1. `packages/bb-agent/src/transport.ts`
- Added an exported **structural mirror** interface `RealtimeChannelDescriptor`
  (`{ __blocks: 'realtime/channel'; channel: string; [key: string]: unknown }`) with a
  doc comment.
  - **Deviation from task text (justified):** the task said to `import type
    { RealtimeChannelDescriptor } from '@aws-blocks/bb-realtime'`. That type is defined in
    bb-realtime's `types.ts` but is **NOT exported from the bb-realtime package entry**
    (`index.ts` exports `RealtimeChannel`, `SubscribeOptions`, etc. — not the descriptor).
    A direct import fails `tsc` (`TS2305: has no exported member 'RealtimeChannelDescriptor'`),
    and adding the export would mean editing bb-realtime source, which is a hard MUST-NOT.
    So I followed the **exact precedent already in this package**: `index.hooks.ts` mirrors
    the same wire type structurally as `ChatChannelDescriptor` ("so the client hooks take
    no hard type dependency on bb-realtime"). The mirror's fields match the descriptor
    exactly, so a `refresh` typed against it stays assignable to bb-realtime's
    `SubscribeOptions.refresh` when the adapter forwards it to `channel.subscribe(...)` —
    confirmed cast-free by the test-app `tsc --noEmit` PASS.
- `ChatTransport.subscribe` interface `opts`: added `refresh?: () => Promise<RealtimeChannelDescriptor>` (+ JSDoc).
- `realtimeTransport` io-object JSDoc example: updated the `subscribe` adapter comment to
  list `{ onMessage, onReconnect, onDisconnect, refresh }` and note the channel calls the
  forwarded `refresh` to re-mint tokens so long turns outlive the channel (~1h)/connect (~2h) TTLs.
- `io.subscribe` handler-options object type: added `refresh?`.
- `realtimeTransport` impl `opts?:` param: added `refresh?`.
- `subscribeArg` gate: now `opts?.onReconnect || opts?.onDisconnect || opts?.refresh
  ? { onMessage, onReconnect, onDisconnect, refresh: opts?.refresh } : onMessage`
  (multiline per Biome-120). Preserved the "PLAIN options object (not callable-with-props)"
  comment and extended it to explain `refresh` is a pure pass-through.

### 2. `packages/bb-agent/src/index.chat.ts`
- Imported the mirror from `./transport.js` (added `RealtimeChannelDescriptor` to the
  existing `import type` line — no reorder).
- `CreateChatOptions`: added `refresh?: () => Promise<RealtimeChannelDescriptor>` (near
  `transport`/`api`) with JSDoc mirroring bb-realtime's `SubscribeOptions.refresh` doc.
- `startTurn`'s `transport.subscribe(channelId, { onReconnect, onDisconnect, refresh })`:
  forwards `refresh: options.refresh`. **Pure pass-through — no createChat refresh state.**

### 3. `test-apps/comprehensive/src/index.ts`
- Added `refresh` to the `createChat(...)` options in `createChatForConvo`:
  `refresh: async () => ({ ...(await api.agentGetRawDescriptor(conversationId)), __blocks: 'realtime/channel' })`.
  Does NOT override the descriptor's `channel` key (per #503 fix). The `subscribe` adapter
  already forwards `handlerOrOptions` verbatim, so `refresh` reaches `channel.subscribe(...)`.
- **No backend change needed:** `api.agentGetRawDescriptor(channelId)` already exists in
  `test-apps/comprehensive/aws-blocks/index.ts` and is already typed
  `{ channel: string; [key: string]: unknown }` (per #503), so the spread is cast-free.

## Verification
- `npm run generate:sources` — OK
- `npx tsc --build` (repo root) — **PASS**
- `packages/bb-agent && npm test` — **exit 0, fail 0.** Main suite 137/137; aggregate across
  the 4 test files 0 failures (a 4-test delta vs total is skipped, not failed). No
  `CannotFindAsset` occurred in this run (the known-unrelated cdk failures did not surface).
- `test-apps/comprehensive && npx tsc --noEmit` — **PASS, cast-free.**

## Constraints honored
- No `as any` / `: any` / `@ts-ignore` / `as unknown as` in changed bb-agent files (grep-verified).
- Tabs, single quotes, semicolons. My added lines are Biome-clean.
- The 2 residual `biome check` findings (import sort + a formatter diff) are on **pre-existing
  untouched lines** (`getConversation` signature, two `onInterrupt` calls, and the import
  order) that were already non-120-formatted at HEAD — not introduced by this change. Biome
  `format --write` initially "fixed" those unrelated lines; I reverted them to keep the diff
  minimal + faithful.
- No bb-realtime source changes; no commit/push; reconnect logic not reimplemented.
