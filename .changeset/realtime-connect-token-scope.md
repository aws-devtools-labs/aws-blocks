---
"@aws-blocks/bb-realtime": patch
---

Harden subscription token validation. Connect tokens now use a `$connect` suffix that prevents them from being reused as channel subscription tokens via prefix matching. Channel tokens remain valid as connect tokens. Backward-compatible during rollout.
