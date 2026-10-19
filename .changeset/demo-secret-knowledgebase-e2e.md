---
"@aws-blocks/create-blocks-app": patch
---

test(demo): add canary e2e for Secret and KnowledgeBase

The `demo` template now exercises two more Building Blocks through
mock-runnable e2e tests (no AWS): Secret (set, rotate, read the previous value
across the rotation grace window, and confirm two labeled versions) and
KnowledgeBase (semantic search over a small committed `knowledge/` corpus,
asserting the billing query retrieves `billing.md` over the unrelated shipping
doc). Raises the daily canary's Building Block coverage without changing any
template runtime behavior.
