# Task: Authenticated Notepad

Build a personal notepad in this AWS Blocks app. A visitor signs up with their email (confirming it with an emailed one-time code) or signs in, edits a single private note, and that note is saved to their account — it survives a reload and is never visible to other users.

The core of this task is **using the framework**: the note is read and written through an **`api` namespace** whose methods run **on the server** and persist through the app's auth + key/value blocks. The page is a thin client over that API.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

## Requirements

### The `api` namespace (primary surface)

Expose an **`api` namespace** (the framework's server-side RPC surface — a `POST /aws-blocks/api` JSON-RPC endpoint) with these methods. Each note operation must run **on the server** and persist through the **key/value block** under the per-user key `note:{userId}`, where `userId` is the signed-in user's stable unique identifier from the auth session. Both methods derive the current user from the **auth session** (the sign-in cookie) — the note key is **never** taken from a client-supplied argument. Store the identifier **verbatim** in the key (`note:{userId}`) — no URL-encoding, hashing, or case-folding — so the key maps exactly back to the authenticated identity.

1. **`api.getNote()`** — returns the signed-in user's saved note as a **string** (the empty string `""` when they have never saved one). Structured return: exactly the string value, nothing appended.
2. **`api.saveNote(text)`** — saves `text` as the current user's single note and returns the stored value. Saving **overwrites** (it does not append). Saving `""` is allowed and **clears** the note (the stored value becomes `""`). Notes are stored and returned **verbatim** — exactly the characters saved, with no HTML interpretation or escaping (a note containing markup such as `<b>x</b>` round-trips as that literal string). Notes up to a few thousand characters round-trip unchanged. A **missing or non-string** argument is rejected with a JSON-RPC **error** envelope and leaves the stored note **unchanged** (no degenerate empty save).

**Auth gating (framework-enforced):** both methods require an authenticated session. Called with **no session** (e.g. a direct `POST /aws-blocks/api` carrying no sign-in cookie), a note method must return a JSON-RPC **error** envelope (unauthenticated) — **not** a `result`, and never another user's data. **Per-user isolation:** each user's `getNote` returns only their own note.

### Test-harness hook: `api.getLastCode()`

The grader has no mailbox, so expose **`api.getLastCode()`**: it returns the most recently delivered verification code as `{ username, code }` (or `null`), where `username` is the email the code was sent to. **This is a test-only backdoor and MUST NOT be a production attack surface:** annotate it `@blocksSkipCodegen` (keep it out of the generated client/types) and gate its body so it returns `null` unless `process.env.BLOCKS_MOCK === 'true'`. In a real deployment the code is emailed and never retained, so outside mock/test mode this method must reveal nothing. The bench runs the dev server with `BLOCKS_MOCK=true`.

### The page (thin client / light smoke)

1. A signed-out visitor sees an email field, a password field, and a submit button. Submitting with a new email signs the visitor up, which emails them a one-time confirmation code; submitting with an existing account's email and password signs that user in.
2. After signing up, the visitor sees a code field and its own submit button. Submitting the emailed code confirms the account and establishes the auth session — the visitor lands signed in without typing the password again.
3. Once authenticated, the visitor sees a single editable note (a textarea), a save button, and a display of the current note; the signed-out form is gone. The save button calls `api.saveNote`; on load / after reload the editor and display are populated from `api.getNote` (so the note is pre-filled, not blank).
4. A signed-in visitor can sign out, returning to the signed-out form.

Exactly one note per user. No password reset or multiple notes.

## Selector contract

The page smoke test uses these `data-testid` hooks. Implement them exactly. The signed-out, code-entry and signed-in views are told apart by which hooks are present: the auth fields show only when signed out; the code hooks only while confirming a sign-up; the note hooks and sign-out button only when signed in. An inactive view's hooks must be **removed** from the DOM (not merely hidden with CSS).

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=auth-email]` | `<input type="email">` | Email address; shown when signed out |
| `[data-testid=auth-password]` | `<input type="password">` | Password; shown when signed out |
| `[data-testid=auth-submit]` | `<button>` | Submit credentials to sign up or sign in |
| `[data-testid=auth-code]` | `<input>` | The emailed confirmation code; shown only after sign-up |
| `[data-testid=auth-code-submit]` | `<button>` | Submit the code to confirm the account and sign in |
| `[data-testid=auth-signout]` | `<button>` | Sign out; shown only when signed in |
| `[data-testid=note-textarea]` | `<textarea>` | The current user's editable note; shown only when signed in |
| `[data-testid=note-save]` | `<button>` | Save the note (calls `api.saveNote`) |
| `[data-testid=note-display]` | element in the signed-in view | Renders the currently-saved note text (empty string when the user has no saved note) |

After a reload (or a fresh sign-in), `[data-testid=note-textarea]`'s value must equal the user's saved note (loaded via `api.getNote`).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Password reset, OAuth, MFA
- More than one note per user; rich-text or markdown rendering
- Sharing notes between users
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
- **Source inspection (grader; behaviorally unverifiable at runtime):** confirm in the source that `api.getLastCode` returns `null` unless `process.env.BLOCKS_MOCK === 'true'`. The bench always runs with `BLOCKS_MOCK=true`, so the Playwright grader never exercises that branch.
