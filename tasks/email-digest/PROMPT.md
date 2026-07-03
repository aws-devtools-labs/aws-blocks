# Task: Scheduled Email Digest

Build a scheduled email-digest feature in this AWS Blocks app. A recurring job is wired up to send a digest email; the app also lets you trigger that same digest on demand and shows when the last digest was sent and to whom.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

This is the `demo` template.

## Requirements

1. **A recurring scheduled job.** The digest runs on a real recurring schedule (e.g. once an hour). **The schedule must be declared even though the test triggers manually** — it proves the recurring wiring exists.
2. **Shared digest logic + manual trigger.** Factor the digest work into a plain function and call it from *both* the scheduled handler **and** an exposed API method named so the UI can run it on demand (e.g. `triggerDigest()`).
3. **Sending email.** The digest sends an email via the email-client block. Locally this is a mock — it logs the message and writes it to `.bb-data/.../emails.json`; no real mailbox or SES setup is needed. Give the client a sender address and pick a recipient for the digest.
4. **Cache last-sent metadata.** After sending, store the last-sent metadata in the key/value store block as structured JSON with at least a **recipient** (`to`) and a fresh **ISO timestamp** (`at`, e.g. `new Date().toISOString()`).
5. **UI.** Show the last-sent info in `[data-testid=last-email]` and a `[data-testid=trigger-btn]` button. Clicking the button runs the digest (the manual trigger), then refreshes the displayed last-sent info. After a successful trigger, `[data-testid=last-email]` must read like **`sent to <recipient> at <time>`** — it must contain the phrase **`sent to`**, the actual recipient **email address**, and a **time**.
6. **Structured read-back + persistence.** Expose an API method `getLastDigest()` that returns the stored record as **exactly** `{ to, at }` — those two fields **only** (recipient string + ISO timestamp), reading it back from the key/value store. `at` must be a canonical **ISO-8601** instant (`new Date().toISOString()` — not a locale string or an epoch number). The displayed recipient and timestamp must survive a full page reload (re-read from the store on load).
7. **Parameterized send + recipient validation.** Also expose an API method `triggerDigestTo(to)` that runs the **same** digest (shares the digest function) to a **caller-supplied** recipient, then updates the stored `{ to, at }` exactly like the scheduled run. **Validate `to` first**: it must be a non-empty, email-shaped address. A **missing, blank, or malformed** recipient is rejected with a JSON-RPC **error** envelope and must **not** send an email or modify the last-sent record (validate before sending — never persist a record for a send that didn't happen). Triggering several digests in sequence updates the last-sent record each time, so `getLastDigest()` always reflects the **most recent** send and stored timestamps advance in order.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=trigger-btn]` | `<button>` | Runs the digest on demand (the manual trigger that shares the cron handler's logic) |
| `[data-testid=last-email]` | element on the page | Shows the last-sent digest info; after a trigger it must contain `sent to <recipient> at <time>` (recipient address + time), and survive a reload |

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
