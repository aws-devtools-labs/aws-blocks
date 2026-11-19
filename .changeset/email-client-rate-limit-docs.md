---
'@aws-cdk-blocks/bb-email-client': patch
---

docs(bb-email-client): explain why the block doesn't rate-limit callers, and what happens to the app's SES account if an app that sends on a caller's behalf doesn't add its own limit. The README also shows one way to add a per-user limit with a `KVStore` counter.
