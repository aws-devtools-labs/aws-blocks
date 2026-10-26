---
"@aws-blocks/bb-email-client": patch
---

`EmailClient` improvements:

- `sendBatch()` sends a message without `html` as plain text only, as `send()` already does. It previously reused the plain-text `body` as the HTML part, where a mail client would render any markup in it.
- The deployed client now validates every message the same way the local one does, before calling SES: addresses (To, CC, BCC and `fromAddress`), at most 50 recipients and at most 40 MB. Invalid input throws `InvalidInputException` (or `EmailSendFailedException` for size) from `send()`, and is marked `failed` in `sendBatch()` results. Addresses may also carry a display name (`Jane Doe <jane@example.com>`), which SES accepts.
- The execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`. The unused `ses:SendRawEmail`, `ses:SendTemplatedEmail` and `ses:SendBulkTemplatedEmail` actions are no longer granted.
