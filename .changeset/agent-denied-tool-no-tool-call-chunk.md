---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

Don't publish a `tool-call` chunk for a tool call that never runs. When the user denies a tool that needs approval, or `maxToolIterations` stops a call, the stream no longer sends a `tool-call` chunk, nor the `tool-result` chunk for the cancellation that follows. Approved and unguarded tools still publish one `tool-call` and one `tool-result`. Conversation history is unchanged: a denied call keeps its paired `tool-call`/`tool-result` rows, and the `tool-result` row records the denial.
