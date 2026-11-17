---
"@aws-blocks/bb-distributed-data": patch
---

Upgrade `dsql-lint` to 0.2.20: partial indexes (`CREATE INDEX ASYNC ... WHERE`)
are supported by Aurora DSQL and no longer rejected locally or at synth.
