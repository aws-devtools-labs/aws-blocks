---
"@aws-blocks/bb-distributed-table": patch
---

The GSI manager's log groups no longer outlive the stack. Its provider framework functions now log to a log group the stack owns, and none of the GSI manager's Lambda roles may create a log group, so a last log flush during `destroy()` can no longer recreate a deleted group outside the stack.
