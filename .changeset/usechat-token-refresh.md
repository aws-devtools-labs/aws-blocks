---
"@aws-blocks/bb-agent": minor
---

useChat now forwards an optional consumer-supplied `refresh` callback to the Realtime subscription so reconnects mint fresh tokens and survive past the channel/connect token TTLs on long turns. The callback is channel-aware — `refresh?: (channelId: string) => Promise<ChatChannelDescriptor>` — so it re-mints for the channel actually in use rather than one captured at construction.

useChat only holds the channelId plus the consumer's `subscribe` adapter; the channel descriptor is minted inside that adapter, which useChat cannot reach — so it cannot self-mint. `UseChatOptions` accepts the optional `refresh` that useChat binds to the current channelId and forwards to the subscription (as `refresh` on the `ChatSubscribeOptions` object). The transport calls it before each reconnect (never on the initial subscribe) to obtain a freshly-minted connect + channel token, so a subscription can outlive the channel (~1h) and connect (~2h) token TTLs.

The same callback is available on the compute-agnostic surfaces: `CreateChatOptions.refresh` lets `createChat` bind the resolved channelId at the subscribe call site and forward it through the transport to the Realtime channel. `realtimeTransport` exposes it as `ChatTransport.subscribe`'s `opts.refresh`, a pure pass-through that the transport forwards into the Realtime channel's subscribe options while holding no refresh state.

`refresh` must resolve to the RAW channel descriptor (the wire object with `__blocks`/token fields), not a hydrated channel client. Fully backward compatible: when omitted, a reconnect replays the original tokens exactly as before.
