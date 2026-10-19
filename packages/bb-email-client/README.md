# @aws-blocks/bb-email-client

Transactional email sending via Amazon SES.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Usage

```typescript
import { EmailClient } from '@aws-blocks/bb-email-client';

const emailClient = new EmailClient(scope, 'notifications', {
  fromAddress: 'noreply@example.com',
  configurationSet: 'my-tracking-set', // optional
});

// Send a single email
const { messageId } = await emailClient.send({
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up.',
  html: '<h1>Welcome!</h1><p>Thanks for signing up.</p>',
});
console.log('Sent:', messageId);

// Send a batch of emails (uses SES SendBulkEmail API with inline templates — no setup required)
const result = await emailClient.sendBatch([
  { to: 'alice@example.com', subject: 'Hi Alice', body: 'Hello!' },
  { to: 'bob@example.com', subject: 'Hi Bob', body: 'Hello!' },
]);
const sent = result.results.filter(r => r.status === 'success').length;
const failed = result.results.filter(r => r.status === 'failed').length;
console.log(`Sent: ${sent}, Failed: ${failed}`);
```

## API

### `new EmailClient(scope, id, options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `fromAddress` | `string` | ✅ | Verified sender email address |
| `replyTo` | `string[]` | ❌ | Reply-to addresses |
| `configurationSet` | `string` | ❌ | SES configuration set name |

### `emailClient.send(message): Promise<SendResult>`

Send to one or more recipients. Returns `{ messageId: string }`.

| Field | Type | Description |
|-------|------|-------------|
| `message.to` | `string \| string[]` | Recipient address(es) |
| `message.subject` | `string` | Subject line |
| `message.body` | `string` | Plain text body |
| `message.html` | `string?` | HTML body (optional) |
| `message.cc` | `string[]?` | CC addresses (optional) |
| `message.bcc` | `string[]?` | BCC addresses (optional) |

### `emailClient.sendBatch(messages): Promise<SendBatchResult>`

Send multiple messages using the SES `SendBulkEmail` API with inline templates.
No stored SES template is required — each message's subject, body, and HTML are passed
directly via `TemplateContent`.

Returns `{ results: Array<{ status, messageId?, error? }> }`.

Never throws on send failures. Both partial and total failures are reported per-entry in the
`results` array (with `status: 'failed'`). A failed entry's `error` is a stable message naming
the error code or the SES entry status (e.g. `EmailSendFailedException: Email send failed (MESSAGE_REJECTED).`);
the raw SES error text is logged server-side, not returned.

A message without `html` is sent as plain text only, as with `send()`: its `body` is never used
as an HTML part. Messages that fail validation (see below) are marked `failed` and not sent.
Messages with `html` are sent in their own `SendBulkEmail` calls, before the text-only ones, so the
order messages go out (and use up the SES sending rate) can differ from the input order; `results`
stays in input order.

Each message in the array is an `EmailMessage` (same type as `send()`):

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `body` | `string` | Plain text body |
| `html` | `string?` | HTML body (optional) |
| `cc` | `string[]?` | CC addresses (optional) |
| `bcc` | `string[]?` | BCC addresses (optional) |

### Input validation

`send()` and `sendBatch()` validate each message the same way locally and when deployed, before
calling SES:

- every address (To, CC, BCC, `fromAddress` and `replyTo`) must be a valid email address, either
  bare (`jane@example.com`) or with a display name made of plain words or one quoted string
  (`Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`). The address is checked as
  given: surrounding whitespace and control characters are rejected;
- at most 50 recipients per message (To + CC + BCC combined);
- at most 40 MB per message.

A malformed address or too many recipients throws `InvalidInputException`; an oversized message
throws `EmailSendFailedException`. In `sendBatch()` the message is marked `failed` instead.

## Error Handling

```typescript
import { EmailErrors } from '@aws-blocks/bb-email-client';
import { isBlocksError } from '@aws-blocks/core';

try {
  await emailClient.send({ to: 'user@example.com', subject: 'Hi', body: 'Hello' });
} catch (e: unknown) {
  if (isBlocksError(e, EmailErrors.SendFailed)) {
    // General send failure — the SES error is logged server-side and kept on `e.cause`
  }
  if (isBlocksError(e, EmailErrors.InvalidInput)) {
    // Malformed input (e.g. invalid email address)
  }
  if (isBlocksError(e, EmailErrors.DomainNotVerified)) {
    // Sending domain not verified in SES
  }
  if (isBlocksError(e, EmailErrors.AccountPaused)) {
    // Account sending is paused by AWS
  }
  if (isBlocksError(e, EmailErrors.RateLimited)) {
    // Transient — safe to retry after backoff
  }
}
```

Each error's message is a stable, Building Block-authored string, so it is safe to forward to a client. The raw SES error (which can name identities, regions, configuration sets and account state) is logged through the block's logger and kept on the error's non-enumerable `cause` for server-side diagnostics.

## Local Development

In local dev mode (`npm run dev`), emails are:
- Logged to the console as a block (body and HTML truncated):
  ```
  [Email:{id}]
    Recipient: a@example.com, b@example.com
    Subject:   ...
    Body:      ...
    HTML:      ...   (only when html is set)
  ```
- Persisted to `.bb-data/{fullId}/emails.json` for inspection
- Validated with the same checks as the deployed client, so an address or message rejected locally is rejected the same way when deployed

## Package Export Conditions

This package uses a custom `"cdk"` export condition:

```json
{
  "exports": {
    ".": {
      "cdk": "./dist/index.cdk.js",
      "aws-runtime": "./dist/index.aws.js",
      "default": "./dist/index.mock.js"
    }
  }
}
```

> **Note:** The `"cdk"` condition is a Blocks framework convention, resolved by the Blocks build
> toolchain (tsx with `--conditions=cdk`). It is **not** a built-in Node.js condition and will
> not resolve in standard `node` or `ts-node` unless you pass `--conditions=cdk` explicitly.

## Limits

- **Per-message recipients**: 50 recipients max per message (To + CC + BCC combined)
- **Batch API destinations**: 50 destinations per `SendBulkEmail` API call (handled automatically via chunking)
- **Message size**: 40 MB per message
- **SES sandbox rate**: 1 email/sec (request production access for higher throughput)

> **Note:** Both the mock and the AWS runtime enforce the per-message recipient and size limits
> locally before calling SES (see [Input validation](#input-validation)): `send()` throws, and
> `sendBatch()` records the violation as a failed entry in `results`.


