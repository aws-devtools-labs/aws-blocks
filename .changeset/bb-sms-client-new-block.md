---
"@aws-blocks/bb-sms-client": minor
"@aws-blocks/blocks": minor
---

feat(bb-sms-client): new SmsClient building block for transactional SMS and mobile push via Amazon SNS

Adds `SmsClient` with `send()` / `sendBatch()` for E.164 SMS and `push()` for mobile push notifications to SNS platform endpoints or topics (rich APNS/FCM payloads when a title, data, or badge is supplied). Includes the local mock (console + `.bb-data` persistence with E.164 / body-size / target validation), AWS SNS runtime, and CDK IAM wiring. Re-exported from `@aws-blocks/blocks`.
