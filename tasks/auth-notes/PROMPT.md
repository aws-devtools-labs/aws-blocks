# Task: Authenticated Notepad

Build a personal notepad in this AWS Blocks app. A visitor signs up (or signs in), edits a single private note, and that note is saved to their account — it survives a reload and is never visible to other users.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

1. A signed-out visitor sees a username field, a password field, and a submit button. Submitting signs them up (or signs an existing user in).
2. Once authenticated, the visitor sees a single editable note (a textarea) and a save button — the signed-out form is gone.
3. Clicking save stores the note for the current user (per-user, in a key/value block under the key `note:{username}`). Saving **overwrites** the user's single note — it does not append. Saving while the textarea is empty is allowed and **clears** the note (the saved value becomes the empty string).
4. **Persistence:** after a full page reload the visitor is still signed in, the textarea is **pre-filled** with their saved note (not blank), and the display shows it. Notes are stored and rendered **verbatim** — exactly the characters saved, with no HTML interpretation (a note containing markup such as `<b>x</b>` is shown as literal text, not a bold element). Notes up to a few thousand characters round-trip unchanged.
5. **Per-user isolation:** a different user who signs in sees their own note (empty until they save one), never another user's note.
6. A signed-in visitor can sign out, which returns them to the signed-out form.

Exactly one note per user. No password reset, email verification, or multiple notes.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. Read the relevant ones before deciding which building blocks to use.

You'll need a block that provides authentication (sign-up / sign-in / sign-out, plus a way to know who the current user is) and a block for per-user stored data. Pick whichever ones fit.

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly. The signed-out and signed-in views are told apart by which hooks are present: the auth fields show only when signed out; the note hooks and sign-out button show only when signed in.

An inactive view's hooks must be REMOVED from the DOM (the grader asserts `toHaveCount(0)`); hiding them with CSS (`display:none` / `hidden`) will fail.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=auth-username]` | `<input type="text">` | Username; shown when signed out |
| `[data-testid=auth-password]` | `<input type="password">` | Password; shown when signed out |
| `[data-testid=auth-submit]` | `<button>` | Submit credentials to sign up or sign in |
| `[data-testid=auth-signout]` | `<button>` | Sign out; shown only when signed in |
| `[data-testid=note-textarea]` | `<textarea>` | The current user's editable note; shown only when signed in |
| `[data-testid=note-save]` | `<button>` | Save the note for the current user |
| `[data-testid=note-display]` | element in the signed-in view | Renders the currently-saved note text (empty string when the user has no saved note) |

After a save, `[data-testid=note-display]` must show exactly the text that was saved. After a reload (or a fresh sign-in), `[data-testid=note-textarea]`'s value must equal the user's saved note.

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Password reset, email verification, OAuth, MFA
- More than one note per user; rich-text or markdown rendering
- Sharing notes between users
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
