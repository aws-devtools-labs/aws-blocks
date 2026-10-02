---
"@aws-blocks/bb-data": patch
---

Make `db pull`-generated database wiring honor CDK's `projectRoot` context when resolving the stack-scoped production connection parameter. This keeps direct CDK invocations from another working directory aligned with the standard Blocks deploy scripts.
