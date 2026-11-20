---
'@aws-cdk-blocks/bb-email-client': patch
---

`send()` and `sendBatch()` now reject a subject that contains CR, LF or another control character (C0, DEL, C1, U+2028, U+2029) with `InvalidInputException`, locally and when deployed. Previously the local mock sent such a message while SES rejected it. In `sendBatch()` the entry is marked `failed` and not sent.
