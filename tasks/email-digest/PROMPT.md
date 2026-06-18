# Task: Scheduled Email Digest

Build a scheduled email-digest feature in this AWS Blocks app. A recurring job is wired up to send a digest email; the app also lets you trigger that same digest on demand and shows when the last digest was sent and to whom.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

This is the `demo` template (vanilla-TS frontend in `src/index.ts`, port 3000). It already wires a key/value store block (`KVStore`) — reuse it for the "last sent" metadata. The frontend calls the backend with `import { api } from 'aws-blocks'`.

## Requirements

1. **A scheduled job is declared.** Wire a cron-job block on a real schedule (e.g. `schedule: 'rate(1 hour)'`). Its handler runs the digest. **The schedule must be declared even though the test triggers manually** — it proves the recurring wiring exists.
2. **Shared digest logic + manual trigger.** The cron-job block has **no manual `submit()`/run method**, so factor the digest work into a plain function and call it from *both* the cron handler **and** an exposed API method named so the UI can run it on demand (e.g. `triggerDigest()`).
3. **Sending email.** The digest sends an email via the email-client block (`send({ to, subject, body })`). Locally this is a mock — it logs the message and writes it to `.bb-data/.../emails.json`; no real mailbox or SES setup is needed. Give the client a `fromAddress` and pick a recipient for the digest.
4. **Cache last-sent metadata.** After sending, store the last-sent metadata — at minimum the **recipient** and a **timestamp** — in the key/value store block.
5. **UI.** Show the last-sent info in `[data-testid=last-email]` and a `[data-testid=trigger-btn]` button. Clicking the button runs the digest (the manual trigger), then refreshes the displayed last-sent info. After a successful trigger, `[data-testid=last-email]` must read something like **`sent to <recipient> at <time>`** (it must contain the phrase **`sent to`**).

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md`. Read the cron-job and email-client block READMEs (and the key/value store one) before wiring.

Shape you'll build (read the READMEs for exact options):

```ts
import { ApiNamespace, Scope, KVStore, CronJob, EmailClient } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const store = new KVStore(scope, 'app-store', {});
const email = new EmailClient(scope, 'digest-mail', { fromAddress: 'noreply@example.com' });

// Shared logic — called by the cron handler AND the manual trigger.
async function runDigest() {
  const to = 'subscriber@example.com';
  await email.send({ to, subject: 'Your digest', body: '…' });
  await store.put('last-digest', JSON.stringify({ to, at: new Date().toISOString() }));
  return { to };
}

new CronJob(scope, 'digest', { schedule: 'rate(1 hour)', handler: async () => { await runDigest(); } });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async triggerDigest() { return runDigest(); },
  async getLastDigest() { const v = await store.get('last-digest'); return v ? JSON.parse(v) : null; },
}));
```

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=trigger-btn]` | `<button>` | Runs the digest on demand (the manual trigger that shares the cron handler's logic) |
| `[data-testid=last-email]` | element on the page | Shows the last-sent digest info; after a trigger it must contain `sent to <recipient>` |

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user digests, subscriber management
- Real SES / a real mailbox (the local mock is what runs)
- Digest content curation, templating, scheduling UI, unsubscribe flows
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
