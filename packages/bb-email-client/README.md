# @aws-cdk-blocks/bb-email-client

Transactional email sending via Amazon SES.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

> **Never pass caller input straight to `send()` or `sendBatch()` from an `ApiNamespace` method.**
> That is an open relay. Gate the method with `auth.requireAuth(context)` and build the message on
> the server: see [Security](#security-dont-expose-sending-as-an-open-relay).

## Quick start

```typescript
import { EmailClient } from '@aws-cdk-blocks/bb-email-client';

const emailClient = new EmailClient(scope, 'notifications', {
  fromAddress: 'noreply@your-verified-domain.com', // an address on a domain verified in SES
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

// Send a batch of emails
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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fromAddress` | `string` | required | Verified sender email address |
| `replyTo` | `string[]` | none | Reply-to addresses |
| `configurationSet` | `string` | none | SES configuration set name |
| `maxBatchSize` | `number` | `100` | Most messages one `sendBatch()` call accepts (positive integer). An invalid value throws `InvalidInputException` from the constructor, and at synth |
| `logger` | `ChildLogger` | a `Logger` at `error` level | Logger for the block's internal operations |

#### Reserved sender domains

`fromAddress` must be on a domain SES can verify. Reserved domains can never be verified:
`example.com`, `example.net`, `example.org` and their subdomains, and anything under
`.test`, `.example`, `.invalid` or `.localhost` (RFC 2606 and RFC 6761).

- Deployed: every send from a reserved-domain sender fails with `DomainNotVerifiedException`.
- Synth: the warning `@aws-cdk-blocks/bb-email-client:UnverifiableSender`, in sandbox and production
  alike. A `replyTo` address on such a domain gets `@aws-cdk-blocks/bb-email-client:UndeliverableReplyTo`.
  They are warnings, not errors: the app still synthesizes and deploys.
- Local mock: accepts the address.

If the sender is deliberate (for example a stack that never sends), acknowledge it:

```typescript
import { Annotations } from 'aws-cdk-lib';

Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/bb-email-client:UnverifiableSender');
```

### `emailClient.send(message): Promise<SendResult>`

Send to one or more recipients. Returns `{ messageId: string }`.

`message` is an `EmailMessage`:

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `body` | `string` | Plain text body |
| `html` | `string?` | HTML body (optional) |
| `cc` | `string[]?` | CC addresses (optional) |
| `bcc` | `string[]?` | BCC addresses (optional) |

### `emailClient.sendBatch(messages): Promise<SendBatchResult>`

Send several `EmailMessage`s in one call through the SES `SendBulkEmail` API. No stored SES
template is required. The block splits the batch into `SendBulkEmail` calls of at most 50
destinations.

Returns `{ results: Array<{ status, messageId?, error? }> }`.

A call takes at most `maxBatchSize` messages (default 100). A larger batch throws
`InvalidInputException` (`Batch size 101 exceeds the maximum of 100 messages.`) and nothing is
sent. To send more, split the messages across calls, or raise `maxBatchSize` for a trusted
server-side job; keep the default on anything reachable from the internet.

Send failures, including failures of the whole SES request, are reported per entry in
`results` (with `status: 'failed'`). SES failures use a block-authored `error` string
(e.g. `EmailSendFailedException: Email send failed (MESSAGE_REJECTED).`), not the raw SES error.
Validation failures can include the rejected address.

A message without `html` is sent as plain text only, as with `send()`: its `body` is never used
as an HTML part. Messages that fail validation (see below) are marked `failed` and not sent.
Messages with `html` are sent in their own `SendBulkEmail` calls, before the text-only ones, so the
order messages go out (and use up the SES sending rate) can differ from the input order; `results`
stays in input order.

### Input validation

`send()` and `sendBatch()` validate each message the same way locally and when deployed, before
calling SES:

- every address (To, CC, BCC, `fromAddress` and `replyTo`) must be a valid email address, either
  bare (`jane@example.com`) or with a display name made of plain words or one quoted string
  (`Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`). The address is checked as
  given: surrounding whitespace and control characters are rejected;
- at most 50 recipients per message (To + CC + BCC combined);
- the subject must be a single line: CR, LF and other control characters (C0, DEL, C1, U+2028
  and U+2029) are rejected, not stripped. Remove line breaks from a subject built from user
  input before sending;
- at most 40 MB per message.

A malformed address, too many recipients or a control character in the subject throws `InvalidInputException`; an oversized message
throws `EmailSendFailedException`. In `sendBatch()` the message is marked `failed` instead.

## Errors

Match with `isBlocksError(e, EmailErrors.<Constant>)`. Import both `isBlocksError` and `EmailErrors` from `aws-cdk-blocks`.

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `EmailErrors.InvalidInput` | `InvalidInputException` | A malformed address, a control character in the subject, more than 50 recipients, a batch larger than `maxBatchSize`, an invalid `maxBatchSize`, or SES rejects the request as invalid |
| `EmailErrors.SendFailed` | `EmailSendFailedException` | A message over 40 MB, SES rejects the message, or any other send failure |
| `EmailErrors.DomainNotVerified` | `DomainNotVerifiedException` | The sending domain or address is not verified in SES |
| `EmailErrors.AccountPaused` | `AccountSendingPausedException` | AWS has paused or suspended the account's sending |
| `EmailErrors.RateLimited` | `RateLimitedException` | SES throttles the request. Transient: retry after a backoff |

The local mock throws only `InvalidInput` and `SendFailed`, from input validation.

Raw SES errors can name identities, regions, configuration sets and account state. The block logs them server-side and keeps the original error on the non-enumerable `cause` of a mapped error. Validation messages can include an address from server configuration or a private recipient list. Return an application-safe message instead of forwarding validation errors or failed batch entries verbatim.

## Security: don't expose sending as an open relay

Every `ApiNamespace` method is a public, internet-reachable endpoint with no auth by default. A
method that passes caller input straight to `send()` or `sendBatch()` is an open relay: anyone
who finds the endpoint can send mail of their choosing, to recipients of their choosing, from your
verified domain. That burns your SES sending quota, can get your account's sending paused, and
damages your domain's reputation.

Gate the method with `auth.requireAuth(context)` from an auth block, and build the
message on the server so the caller can't choose the recipients or the content:

```typescript
import { Scope, ApiNamespace, ApiError } from '@aws-cdk-blocks/core';
import { Auth } from '@aws-cdk-blocks/bb-auth';
import { KVStore } from '@aws-cdk-blocks/bb-kv-store';
import { EmailClient } from '@aws-cdk-blocks/bb-email-client';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth');
// App-owned profile data, keyed by the user's `userSub`. The app writes each user's address here.
const profiles = new KVStore<{ email: string }>(scope, 'profiles');
// fromAddress must be on a domain verified in SES (see "Reserved sender domains").
const emailClient = new EmailClient(scope, 'notifications', { fromAddress: 'noreply@your-verified-domain.com' });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async sendMeASummary() {
    const user = await auth.requireAuth(context); // throws 401 for a caller who isn't signed in
    // Look the address up from app-owned data, so this only ever mails the signed-in user.
    const profile = await profiles.get(user.userSub);
    if (!profile) throw new ApiError('No email address on file', 404);
    return await emailClient.send({
      to: profile.email,
      subject: 'Your summary',
      body: 'Here is your summary.',
    });
  },
}));
```

### Per-user send limit

Authentication alone does not stop a signed-in user from sending a lot of mail:

- `sendBatch()` caps one call at `maxBatchSize` messages, not how many calls a caller makes.
- The block does not rate-limit callers: only your method knows who the caller is.
- If a gated method still sends on the caller's behalf, add your own per-user limit. Without it,
  the cost lands on your AWS account, bounces and complaints count against your domain's
  reputation, and SES can put your account under review, pause its sending, or suspend it.

One way to add the limit is a per-user counter in a `KVStore` with TTL turned on. Key the counter
by user and time window, so each window starts on a fresh key and the old one expires on its own,
and update it with a conditional `put`, so two concurrent requests can't both take the last slot:

```typescript
const MAX_SENDS_PER_HOUR = 10;
// `ttl: true` lets each window's counter expire once the window is over.
const sendCounts = new KVStore<number>(scope, 'send-counts', { ttl: true });

async function takeSendSlot(userSub: string): Promise<void> {
  const windowStart = Math.floor(Date.now() / 3_600_000) * 3600; // start of this hour, epoch seconds
  const windowEnd = windowStart + 3600;
  const key = `${userSub}:${windowStart}`;
  // A strongly consistent read sees the latest count, so fewer requests lose a race below.
  const count = await sendCounts.get(key, { consistentRead: true });
  if (count !== null && count >= MAX_SENDS_PER_HOUR) {
    throw new ApiError('Too many emails. Try again later.', 429);
  }
  // Create the counter, or bump it only if no other request changed it since the read.
  // The request that loses a race gets KVStoreErrors.ConditionalCheckFailed (HTTP 409) and sends nothing.
  await sendCounts.put(
    key,
    (count ?? 0) + 1,
    count === null ? { ifNotExists: true, expiresAt: windowEnd } : { ifValueEquals: count, expiresAt: windowEnd },
  );
}
```

Call `await takeSendSlot(user.userSub)` right after `auth.requireAuth(context)` in the method above,
before `emailClient.send()`.

## Scaling and cost (AWS)

An SES sandbox account sends 1 email per second. Request production access for higher throughput.

## Local development

In local dev mode (`npm run dev`), emails are:
- Logged to the console as a block (body and HTML truncated):
  ```
  [Email:{id}]
    Recipient: a@example.com, b@example.com
    Subject:   ...
    Body:      ...
    HTML:      ...   (only when html is set)
  ```
- Persisted to `.cdk-blocks/local/data/{fullId}/emails.json` for inspection
- Validated with the same checks as the deployed client, so an address or message rejected locally is rejected the same way when deployed
