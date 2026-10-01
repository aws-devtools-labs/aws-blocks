# PR #503 — docs/exports/changeset findings (non-blocking)

Worktree: `/local/home/msober/aws-blocks-token-refresh` (branch `fix/realtime-token-refresh`). No commit/push. Did NOT touch aws-middleware.ts / mock-middleware.ts / reconnect.test.ts (parallel agent owns them).

## Finding A (4155697659) — export the real type, drop the mirrors
- `packages/bb-realtime/src/index.ts`: added `RealtimeChannelDescriptor` to the `export type { … } from './types.js'` block (same style as `SubscribeOptions`/`DisconnectReason`).
- `packages/bb-agent/src/transport.ts`: deleted the local `RealtimeChannelDescriptor` mirror interface; now `import type { DisconnectReason, RealtimeChannelDescriptor } from '@aws-blocks/bb-realtime'` + `export type { RealtimeChannelDescriptor }` so `index.chat.ts`'s `./transport.js` import still resolves. No casts.
- `packages/bb-agent/src/index.hooks.ts`: deleted the local `ChatChannelDescriptor` mirror interface; added `RealtimeChannelDescriptor` to the bb-realtime import; replaced with `export type ChatChannelDescriptor = RealtimeChannelDescriptor;` (keeps the consumer-facing name on the useChat surface). Both `ChatSubscribeOptions.refresh` and `UseChatOptions.refresh` return types unchanged (alias is identical type → assignable to bb-realtime's `SubscribeOptions.refresh`).
- `packages/bb-agent/src/index.chat.ts`: added `RealtimeChannelDescriptor` to `export type { … } from './transport.js'` so createChat users can name the refresh return type from the client entry.

## Finding B (4155697664) — refresh CONTRACT on both surfaces
Rewrote the `refresh` JSDoc on `CreateChatOptions.refresh` (index.chat.ts) and `UseChatOptions.refresh` (index.hooks.ts), and the useChat `@example`, to state the contract (neutral language, no disclosure terms):
1. app server method returns `channel.toJSON()` with the `__blocks` discriminant stripped (so response middleware won't hydrate it);
2. this callback re-adds `__blocks: 'realtime/channel'`;
3. that server method re-issues a connect + channel token, so it MUST apply the SAME authorization as the method that issued the original channel (credential-issuing endpoint; gate it like the original).
`agentGetRawDescriptor` kept only as "the test app's example server method".

## Finding C (4155697671) — DESIGN.md + types.ts accuracy
- `packages/bb-realtime/src/types.ts` `SubscribeOptions.onDisconnect` JSDoc: corrected the `'error'` count — fires **once per failed reconnect attempt plus once at give-up** (e.g. 1 drop + 5 attempts + 1 give-up = 7), with a note that apps COUNTING `'error'` should expect the fan-out (harmless for useChat/createChat — `armFailsafe` idempotent).
- `packages/bb-realtime/DESIGN.md`: replaced the false "Connection-level scoping (limitation)" bullet (per-connection last-writer-wins; sibling stale-token rejection surfacing connection-wide; "does not bite the primary useChat case") with a **Per-channel refresh** bullet: each subscribed channel keeps its own refresher and re-mints its own token in parallel on reconnect (instance connect token taken from any one); a channel whose refresh fails falls back to its stored token and its rejection is **channel-scoped**; connection-wide `onDisconnect('error')` is reserved for the refresh/reconnect-FAILURE (give-up) path.

## Finding D (bobbor 4156219340) — changesets (bumps unchanged)
- `.changeset/usechat-token-refresh.md` (`@aws-blocks/bb-agent: minor`): added coverage for `createChat` (`CreateChatOptions.refresh`) and `realtimeTransport` (`ChatTransport.subscribe` `opts.refresh`, pure pass-through); corrected the signature to channel-aware `(channelId) => Promise<ChatChannelDescriptor>`; removed the misleading hydrated-client `() => api.agentGetChannel(conversationId)` example and stated the RAW-descriptor requirement.
- `.changeset/realtime-token-refresh.md` (`@aws-blocks/bb-realtime: minor`): added a sentence making the model per-channel (re-mints every live channel's token in parallel; channel-scoped fallback), replacing the singular "resubscribe with the fresh channel token".

## PR-DESCRIPTION correction for the orchestrator (do NOT run gh pr edit from me)
The PR body says refresh is `typically () => api.agentGetChannel(conversationId)`. That returns a HYDRATED client, fails `isRealtimeDescriptor`, and makes every reconnect a give-up. Replace with:

> `refresh` is channel-aware — `(channelId) => Promise<descriptor>` — and must resolve to the RAW channel descriptor (the wire object with `__blocks`/token fields), not a hydrated channel. The app exposes a server method returning `channel.toJSON()` with the `__blocks` discriminant stripped (so the response middleware won't hydrate it); the callback re-adds `__blocks: 'realtime/channel'`. That method re-issues tokens, so it applies the same authorization as the method that issued the original channel. Example (test app): `async (channelId) => ({ ...(await api.agentGetRawDescriptor(channelId)), __blocks: 'realtime/channel' })`.

## Verify
- `npm run generate:sources` OK.
- `npx tsc --build` (repo root): the ONLY error is `packages/bb-realtime/src/aws-middleware.ts(266,43): error TS2554: Expected 3 arguments, but got 2` — parallel agent's in-flight edit, NOT caused by my changes.
- Emitted bb-realtime declarations (`tsc -p … --emitDeclarationOnly --noEmitOnError false`) → `dist/index.d.ts` exports `RealtimeChannelDescriptor`.
- `npx tsc --noEmit -p packages/bb-agent` → EXIT 0 (my export + mirror removal compile cast-free).
- `cd test-apps/comprehensive && npx tsc --noEmit` → EXIT 0.
- `git status --short`: only my 8 files (+ the 3 bb-realtime middleware/test files modified by the parallel agent, which I did not touch).

## LEARNINGS / orchestrator action
- api-extractor API.md regen IS needed for bb-realtime (`RealtimeChannelDescriptor` now a real export — clears the `ae-forgotten-export`). The repo script is root-wide `npm run update:api` (→ `bash scripts/update-api-reports.sh`), NOT package-scoped, and runs over built `.d.ts`, so it's blocked until the tree is green (parallel agent's aws-middleware.ts arity error). Run `npm run update:api` once green, then commit the regenerated API.md for bb-realtime (and bb-agent if the re-export shifts its report).
