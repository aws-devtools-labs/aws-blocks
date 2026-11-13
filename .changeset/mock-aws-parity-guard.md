---
'@aws-blocks/blocks': patch
---

Add a repository check that every Building Block with both a local mock and an AWS runtime entry ships a `parity.test.ts` and calls its shared `validation.ts` from both entries. The contributor docs now describe the rule.
