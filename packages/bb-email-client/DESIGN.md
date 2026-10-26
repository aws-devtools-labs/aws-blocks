# Email — Design

Design document for the Email Building Block. For usage, examples, best practices, and scaling guidance, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-email-client`
**Type:** Primitive (new infrastructure)
**AWS Service:** Amazon SES

## Purpose

Email sending for transactional emails — welcome emails, password resets, order confirmations, notifications. For real-time messaging, use `Realtime`. For async job notifications, use `AsyncJob`.

## Infrastructure (CDK)

Creates the following resources:

- **SES Configuration Set:** For delivery tracking and event publishing
	- **Name:** Derived from `scope.fullId`
- **SES Email Identity:** Verifies the `fromAddress` (email-level verification)
	- Domain-level verification is preferred for production but requires DNS access
- **IAM Permissions:** `ses:SendEmail` and `ses:SendBulkEmail` granted to the parent scope's handler automatically

No SNS topics for bounce/complaint handling, no SES templates, no dedicated IP pools.

## Mock Implementation

- Emails are logged to the console with sender, recipients, subject, and a body preview:
	```
	[Email:notifications]
	  Recipient: user@example.com
	  Subject:   Welcome!
	  Body:      Thanks for signing up.
	```
- Emails are also written to `.bb-data/{scope.fullId}/emails.json` as a JSON array for programmatic inspection. Each entry includes `to`, `subject`, `body`, `html` (if provided), `from`, `messageId`, and `timestamp` (ISO 8601).
- `sendBatch()` appends all messages to the same file in a single write.
- Mock validates email address format (basic RFC 5322 check) and throws `InvalidInputException` for malformed addresses.

## Input Validation (mock and AWS)

The mock and the AWS entry point run the same checks from `src/validation.ts` before a message is sent, so a message rejected locally is also rejected when deployed, before any SES call:

- every address (To, CC, BCC and the sender) is a basic RFC 5322 addr-spec, or a name-addr (`Jane Doe <jane@example.com>`, which SES also accepts); control characters, CR and LF included, are rejected;
- at most 50 recipients per message (To + CC + BCC) → `InvalidInputException`;
- at most 40 MB per message → `EmailSendFailedException`.

`send()` throws; within `sendBatch()` an invalid message is marked `failed` in the per-entry results and not sent.

## HTML Part

A message gets an HTML part only when `html` is set, for both `send()` and `sendBatch()`. `sendBatch()` uses `SendBulkEmail`, where one inline template is shared by every entry of a call, so it sends messages with `html` and messages without it in separate calls: the text-only call's template has no HTML part. A plain-text `body` is never placed in an HTML part, where a mail client would render any markup in it.

## IAM

The shared execution role gets `ses:SendEmail` (for `send()`) and `ses:SendBulkEmail` (for `sendBatch()`), scoped to this account's identities and configuration sets. No raw-MIME or stored-template sends are made, so `ses:SendRawEmail`, `ses:SendTemplatedEmail` and `ses:SendBulkTemplatedEmail` are not granted.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No actual email delivery | Emails are never sent; delivery issues only surface in AWS | No mitigation — mock is for development flow, not delivery testing. Sandbox testing covers real delivery |
| No bounce/complaint handling | Bounces and complaints only occur with real email delivery | No mitigation — these are inherently production concerns |
| No sending rate limits | Code that would be throttled in SES sandbox succeeds locally | No mitigation — the mock does not simulate SES rate limits. Recommend sandbox testing for throughput-sensitive flows |
| No domain verification | `DomainNotVerifiedException` never thrown locally | No mitigation — verification is an infrastructure concern handled by CDK. Sandbox testing covers it |
| Per-message recipient limit (50) | A message exceeding 50 recipients (To + CC + BCC) would be rejected by SES | `send()` throws `InvalidInputException`; within `sendBatch()` the offending message is marked `failed` in the per-entry results (matching SES per-entry behavior) |
| 40 MB message size limit | SES rejects messages over 40 MB | The mock and the AWS entry point both validate total message size and throw `EmailSendFailedException` when it exceeds 40 MB (see Input Validation) |
