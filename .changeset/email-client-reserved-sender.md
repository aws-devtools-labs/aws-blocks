---
'@aws-blocks/bb-email-client': patch
'@aws-blocks/create-blocks-app': patch
'@aws-blocks/blocks': patch
---

`EmailClient` now warns at synth when `fromAddress` is on a reserved domain that SES can never verify (`example.com`, `example.net`, `example.org` and their subdomains, or anything under `.test`, `.example`, `.invalid` or `.localhost`), since every send from such an address fails once deployed. The warning id is `@aws-blocks/bb-email-client:UnverifiableSender`, raised in sandbox and production, and can be acknowledged. A `replyTo` address on a reserved domain gets `@aws-blocks/bb-email-client:UndeliverableReplyTo`. The demo template no longer sends from `noreply@example.com`: its sender is an `EMAIL_SENDER` constant with a `.invalid` placeholder to replace with a verified SES identity before deploying to production.
