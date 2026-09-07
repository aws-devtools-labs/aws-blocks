---
"@aws-blocks/bb-agent": minor
---

useChat now forwards an optional consumer-supplied `refresh` callback to the Realtime subscription so reconnects mint fresh tokens and survive past the channel/connect token TTLs on long turns.

useChat only holds the channelId plus the consumer's `subscribe` adapter; the channel descriptor is minted inside that adapter (via `api.agentGetChannel`), which useChat cannot reach — so it cannot self-mint. Instead, `UseChatOptions` accepts an optional `refresh?: () => Promise<ChatChannelDescriptor>` (typically `() => api.agentGetChannel(conversationId)`) that useChat forwards to the subscription (as `refresh` on the `ChatSubscribeOptions` object). The transport calls it before each reconnect (never on the initial subscribe) to obtain a freshly-minted connect + channel token, so a subscription can outlive the channel (~1h) and connect (~2h) token TTLs. Fully backward compatible: when omitted, a reconnect replays the original tokens exactly as before.
