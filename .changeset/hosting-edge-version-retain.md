---
"@aws-blocks/hosting": patch
---

Retain a replaced Lambda@Edge function version instead of deleting it. A deploy that changed Next.js middleware or an Edge route waited several minutes on deletes that Lambda refuses while CloudFront still holds the old version's replicas, then warned that resources failed to delete. Replaced versions now stay in place without running.
