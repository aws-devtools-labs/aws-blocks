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
`results` array (with `status: 'failed'`).

Each message in the array is an `EmailMessage` (same type as `send()`):

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `body` | `string` | Plain text body |
| `html` | `string?` | HTML body (optional) |
| `cc` | `string[]?` | CC addresses (optional) |
| `bcc` | `string[]?` | BCC addresses (optional) |

## Error Handling

```typescript
import { EmailErrors } from '@aws-blocks/bb-email-client';
import { isBlocksError } from '@aws-blocks/core';

try {
  await emailClient.send({ to: 'user@example.com', subject: 'Hi', body: 'Hello' });
} catch (e: unknown) {
  if (isBlocksError(e, EmailErrors.SendFailed)) {
    // General send failure — check error message for details
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

## Local Development

In local dev mode (`npm run dev`), emails are:
- Logged to the console with format: `[Email:{id}] → recipient | Subject: ... | Body: ...`
- Persisted to `.bb-data/{fullId}/emails.json` for inspection
- Batch sends emit a rate-limit warning (simulating SES sandbox behavior)

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

> **Note:** In local dev (mock), per-message recipient and size limits are enforced locally before
> sending (limit violations are recorded as failed entries). In the AWS runtime, these limits are
> enforced by SES itself, so the failure surfaces in the SES response rather than locally — the
> failure point differs between runtimes, but in both cases failures appear per-entry in `results`.


