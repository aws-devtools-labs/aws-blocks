---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): don't show the previous answer when the chat reconnects at the start of a turn

If the chat reconnected before a turn had streamed any text, `createChat` and `useChat` could read a history that did not yet include the new message and show the previous turn's answer as the new one, then ignore the real reply.

On reconnect, a saved answer that repeats the previous turn's answer is no longer taken as the new turn's answer while nothing has streamed. The client keeps waiting for the turn's own chunks instead.
