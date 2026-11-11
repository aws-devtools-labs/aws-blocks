---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): report a turn that failed while the chat was disconnected

If the chat's connection dropped and the turn failed before it reconnected, the `error` chunk was lost. `createChat` and `useChat` then kept loading for about 11 minutes and reported "Timed out waiting for the agent to respond after reconnect." instead of the real error.

On reconnect, both clients now recognize the row the backend saves for a failed turn, including a turn a `maxLlmCalls` or `maxToolIterations` cap stopped, whose partial text they keep. They end the turn right away and pass the recorded error to `onError`, typed the same way as a live `error` chunk (for example `AgentErrors.ModelUnavailable`). When the previous turn also failed, the saved row could be that turn's, so the client keeps waiting for the turn as before.
