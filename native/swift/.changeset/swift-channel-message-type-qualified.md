---
"aws-blocks-swift": patch
---

An operation that returns a realtime channel with an inline message type now compiles

If an operation in your API returned a realtime channel whose message type was declared inline (for example `getChannel(): RealtimeChannel<{ message: string; timestamp: number }>`), the generated Swift client didn't compile: `cannot find type 'ResultMessage' in scope`. The message type is generated inside the operation's namespace (`Api.GetChannel.ResultMessage`), but the method's signature named it without that prefix. The same happened when such a channel was in a list, dictionary or optional result (`[RealtimeChannel<…>]`), or was a parameter.

The method now returns `RealtimeChannel<GetChannel.ResultMessage>`. From another module, name it `RealtimeChannel<Api.GetChannel.ResultMessage>`. Channels whose message type is one of your named types (`RealtimeChannel<Note>`) or a primitive, and file handles, are unchanged.
