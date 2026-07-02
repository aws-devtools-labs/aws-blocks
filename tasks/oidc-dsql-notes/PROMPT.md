# Task: OIDC Notes (DistributedDatabase)

Build a personal notes app gated by OIDC sign-in. A visitor signs in through an OIDC provider, then creates notes that belong to them and persist in a distributed SQL database across reloads.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

This is the `react` template — a React single-page app (frontend entry `src/main.tsx`, which mounts the `src/App.tsx` component). Replace the template's todo demo with your OIDC-gated notes app.

## Requirements

1. **OIDC sign-in.** A signed-out visitor sees a single sign-in button; once signed in, a cookie session is established and the profile + note editor appear.
   - Use the auth block's **stub OIDC provider** for zero-config local sign-in, and **name the provider exactly `stub`**. Configure it to auto-approve the first user, so sign-in needs no interactive account picker.
   - **Simplest, most robust sign-in — a server-initiated redirect.** Make the sign-in button navigate the browser to the block's signin route, **`/aws-blocks/auth/signin/stub`**. That route runs the whole flow through server-side redirects (signin → stub authorize, auto-approved → callback sets the session cookie → back to `/`) and lands the visitor on the app already signed in. No client-side PKCE / redirect-callback wiring is required for this path.
   - On load, **restore the session from the cookie** and render the signed-in view — this is what surfaces the profile once the redirect lands on `/`, and what keeps the visitor signed in across reloads (requirement 4). Use the auth block's documented client/session API to hydrate the current user from the session on load and on every change.
2. **Profile.** Once signed in, show the signed-in user's stable subject id (e.g. the OIDC `userId`) in `[data-testid=profile-sub]`, and hide the sign-in button.
3. **Notes in DistributedDatabase.** A signed-in user can type a note and add it. Notes are stored in a **`DistributedDatabase`** table (create a `.sql` migration under `aws-blocks/dsql-migrations/`), scoped to the current user, and each note renders in the list.
   - Store and display note text **verbatim** — including long notes and unicode / emoji: use **parameterized** SQL (so a note containing a single quote like `' OR '1'='1` round-trips intact rather than breaking the query), and render the text as **text content**, never as HTML (`<b>x</b>` must show literally, not become a real element).
   - **Stable ordering:** list the notes **oldest-first (in the order they were created)**, backed by a stored timestamp or sequential id plus an explicit `ORDER BY` — the order must be identical on every load and after adding more notes (don't rely on unspecified database row order).
   - **No deduplication:** adding the same text twice creates **two** separate note rows.
4. **Persistence.** After a full page reload the visitor is still signed in (session cookie restored) and **all** of their notes are still listed; the note editor remains functional after the reload (adding another note still works).
5. **Input validation.** Disable `[data-testid=add-note-btn]` while the note input is empty or whitespace-only (trim before the check); re-enable it once real text is present.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly. The signed-out vs signed-in views are told apart by which hooks are present: the sign-in button shows only when signed out; the profile + note hooks show only when signed in.

An inactive view's hooks must be REMOVED from the DOM (the grader asserts `toHaveCount(0)`); hiding them with CSS (`display:none` / `hidden`) will fail.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=signin-btn]` | `<button>` | Starts the OIDC sign-in flow; shown when signed out |
| `[data-testid=profile-sub]` | element in the signed-in view | Renders the signed-in user's subject id (non-empty) |
| `[data-testid=note-input]` | `<input>` / `<textarea>` | Where the user types a note |
| `[data-testid=add-note-btn]` | `<button>` | Adds the note for the current user; disabled while the input is empty/whitespace |
| `[data-testid=note-item]` | one per note | A note row; must render the note's text verbatim as text content (no HTML injection) |

A `[data-testid=note-item]` must contain the note's text (the test locates a note via `filter({ hasText: text })`).

The mount point is the existing root element. Replace the template's todo UI.

## Out of scope

- Real OIDC providers / credentials (use the stub provider locally), refresh-token UX, multi-provider pickers
- Editing / deleting / sharing notes, rich text
- Realtime sync between tabs (you're removing the Realtime block)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
