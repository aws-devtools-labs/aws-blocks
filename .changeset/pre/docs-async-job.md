---
"@aws-cdk-blocks/bb-async-job": patch
---

docs: locally a failed delivery is retried at once and an exhausted job is logged, not queued. On AWS the retry wait is `900 + maxBatchingWindowSeconds` seconds on a Lambda compute and about 2 minutes on a container compute.
