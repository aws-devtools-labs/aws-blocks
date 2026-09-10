---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

`useChat`: widen `UseChatOptions.api.sendMessage` and `resume` return types from `Promise<void>` to `Promise<unknown>`.

The natural backend methods return objects (`agent.stream()` → `{ channelId }`, `resume` wrappers → `{ ok: true }`), but `Promise<{ channelId }>` is not assignable to `Promise<void>` (TS2322), which forced customers into an await-and-discard wrapper. `useChat` awaits both calls only for completion and discards the resolved value, so `Promise<unknown>` — assignable-from both object results and `void` — lets natural-shape backends wire up directly while existing `void`-returning backends keep compiling. Type-only change; no runtime behavior change.
