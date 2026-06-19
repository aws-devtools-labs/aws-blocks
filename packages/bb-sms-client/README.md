# @aws-blocks/bb-sms-client

Transactional SMS and mobile push notifications via Amazon SNS.

## Usage

```typescript
import { SmsClient } from '@aws-blocks/bb-sms-client';

const sms = new SmsClient(scope, 'notifications', {
  smsType: 'Transactional', // optional, default 'Transactional'
  senderId: 'ACME',         // optional, where supported by the destination country
});

// Send a single SMS
const { messageId } = await sms.send({
  to: '+14155550123',
  body: 'Your verification code is 1234',
});
console.log('Sent:', messageId);

// Send a batch (sent individually — SNS has no bulk SMS API)
const result = await sms.sendBatch([
  { to: '+14155550101', body: 'Order shipped' },
  { to: '+14155550102', body: 'Order shipped' },
]);
const sent = result.results.filter(r => r.status === 'success').length;
const failed = result.results.filter(r => r.status === 'failed').length;
console.log(`Sent: ${sent}, Failed: ${failed}`);

// Send a mobile push notification to a registered SNS platform endpoint
await sms.push({
  target: 'arn:aws:sns:us-east-1:123456789012:endpoint/GCM/myapp/abc-123',
  title: 'New message',
  body: 'You have a new message from Alice',
  data: { conversationId: '42' },
  badge: 1,
});
```

## API

### `new SmsClient(scope, id, options?)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `smsType` | `'Transactional' \| 'Promotional'` | ❌ | Default delivery class (default `Transactional`) |
| `senderId` | `string` | ❌ | Default alphanumeric sender ID, where supported |

### `sms.send(message): Promise<SendResult>`

Send an SMS to a single E.164 phone number. Returns `{ messageId: string }`.

| Field | Type | Description |
|-------|------|-------------|
| `message.to` | `string` | Destination phone number in E.164 format (`+14155550123`) |
| `message.body` | `string` | Message text (≤ 1600 bytes UTF-8) |
| `message.smsType` | `'Transactional' \| 'Promotional'?` | Per-message delivery class override |
| `message.senderId` | `string?` | Per-message sender ID override |

### `sms.sendBatch(messages): Promise<SendBatchResult>`

Send multiple SMS messages. SNS has no bulk SMS API, so messages are sent individually.
Never throws on send failures — both partial and total failures are reported per-entry in the
`results` array (same order as the input), with `status: 'failed'`.

Returns `{ results: Array<{ status, messageId?, error? }> }`.

### `sms.push(message): Promise<SendResult>`

Publish a mobile push notification to an SNS platform endpoint ARN (a registered device) or a
topic ARN. Returns `{ messageId: string }`.

| Field | Type | Description |
|-------|------|-------------|
| `message.target` | `string` | SNS endpoint ARN or topic ARN |
| `message.body` | `string` | Notification body / `default` message |
| `message.title` | `string?` | Notification title (APNS/FCM) |
| `message.data` | `Record<string, unknown>?` | Structured data payload |
| `message.badge` | `number?` | iOS badge count |

When a `title`, `data`, or `badge` is supplied, the message is published with a platform-specific
JSON structure (`MessageStructure: 'json'`) so APNS and FCM render a rich notification. Otherwise a
plain text message is published.

## Error Handling

```typescript
import { SmsErrors } from '@aws-blocks/bb-sms-client';
import { isBlocksError } from '@aws-blocks/core';

try {
  await sms.send({ to: '+14155550123', body: 'Your code is 1234' });
} catch (e: unknown) {
  if (isBlocksError(e, SmsErrors.InvalidInput)) {
    // Malformed input (e.g. non-E.164 number, empty or oversized body)
  }
  if (isBlocksError(e, SmsErrors.OptedOut)) {
    // Recipient opted out or endpoint disabled — stop messaging this target
  }
  if (isBlocksError(e, SmsErrors.InvalidTarget)) {
    // Unknown or malformed push target ARN
  }
  if (isBlocksError(e, SmsErrors.RateLimited)) {
    // Transient — safe to retry after backoff
  }
  if (isBlocksError(e, SmsErrors.SendFailed)) {
    // General send failure — check error message for details
  }
}
```

## Local Development

In local dev mode (`npm run dev`), messages are:
- Logged to the console with format: `[Sms:{id}]` / `[Push:{id}]` with the destination and body
- Persisted to `.bb-data/{fullId}/messages.json` for inspection
- Validated locally (E.164 phone number, non-empty body, ≤ 1600-byte body, SNS ARN push targets)

No AWS account is required and no real SMS or push is delivered.

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

- **Phone number format**: E.164 only (`+` followed by up to 15 digits)
- **Message size**: 1600 bytes (UTF-8) per SMS; longer text is split into multiple parts by the carrier
- **SMS sandbox**: new accounts can only message verified numbers until production access is granted
- **Spend limit**: SMS throughput is governed by your account's monthly spend limit and origination identities

> **Note:** In local dev (mock), phone-number, body, and target validation are enforced locally
> before sending. In the AWS runtime these are enforced by SNS itself, so the failure surfaces in
> the SNS response rather than locally — the failure point differs between runtimes, but in both
> cases failures appear per-entry in `results` for `sendBatch`.
