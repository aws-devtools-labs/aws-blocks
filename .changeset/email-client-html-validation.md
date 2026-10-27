---
"@aws-blocks/bb-email-client": minor
"@aws-blocks/blocks": minor
---

**Breaking (behavior):** two changes reach apps that are already deployed:

- The deployed `EmailClient` now validates addresses before calling SES, so `send()` throws `InvalidInputException` (and `sendBatch()` marks the message `failed`) for addresses the validator rejects but SES accepted, for example quoted local parts (`"john.doe"@example.com`) or non-ASCII domains.
- The shared execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`. An app that calls the SES SDK directly (for example `SendRawEmail` for attachments) and relied on this block's grant of `ses:SendRawEmail`, `ses:SendTemplatedEmail` or `ses:SendBulkTemplatedEmail` must grant those actions itself.

`EmailClient` changes:

- `sendBatch()` sends a message without `html` as plain text only, as `send()` already does. It previously reused the plain-text `body` as the HTML part, where a mail client would render any markup in it. Messages with `html` are sent in separate calls, before the text-only ones; `results` stays in input order.
- The deployed client validates every message the same way the local one does, before calling SES: every address (To, CC, BCC, `fromAddress` and `replyTo`), at most 50 recipients, and at most 40 MB. Invalid input throws `InvalidInputException` (or `EmailSendFailedException` for size) from `send()`, and is marked `failed` in `sendBatch()` results. Addresses may carry a display name made of plain words or one quoted string (`Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`), which SES accepts. Surrounding whitespace and control characters are rejected.
