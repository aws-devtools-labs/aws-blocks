# Task: OIDC Notes (DistributedDatabase)

Build a personal notes app gated by OIDC sign-in. A visitor signs in through an OIDC provider, then creates notes that belong to them and persist in a distributed SQL database across reloads.

The core of this task is **using the framework**: notes are added and listed through an **`api` namespace** whose methods run **on the server**, derive the caller from the **OIDC auth session**, and persist through the **`DistributedDatabase`** block. The page is a thin client over that API; the OIDC sign-in itself is a browser redirect flow.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

Replace the scaffold's starter todo demo with your OIDC-gated notes app.

## Requirements

### OIDC sign-in (browser flow)

1. A signed-out visitor sees a single sign-in button; clicking it signs the visitor in through an OIDC provider (**named exactly `stub`**), after which a cookie session is established and the profile + note editor appear. On load, the session is **restored from the cookie** and the signed-in view re-renders — keeping the visitor signed in across reloads.
2. Once signed in, show the signed-in user's stable subject id (e.g. the OIDC `userId`) in `[data-testid=profile-sub]`, and hide the sign-in button.

### The `api` namespace (primary surface)

Expose an **`api` namespace** (the framework's server-side RPC surface — a `POST /aws-blocks/api` JSON-RPC endpoint) whose note methods derive the current user from the **OIDC session** (the sign-in cookie) — never from a client-supplied id — and persist through a **`DistributedDatabase`** table (create a `.sql` migration under `aws-blocks/dsql-migrations/`):

1. **`api.addNote(text)`** — inserts a note for the current user and returns the created row `{ id, text }`. Text is stored **verbatim** via **parameterized** SQL — a note containing a single quote such as `' OR '1'='1` round-trips intact (never breaks or injects into the query) and is never HTML-processed. There is **no deduplication** (adding the same text twice creates two rows). A blank/whitespace-only or non-string `text` is rejected with a JSON-RPC **error** envelope (no row inserted).
2. **`api.listNotes()`** — returns the current user's notes as `[{ id, text }]` in **oldest-first** creation order, backed by a stored timestamp / sequential id plus an explicit `ORDER BY` (identical on every call, never relying on unspecified row order).

**Auth gating (framework-enforced):** both methods require an authenticated OIDC session. Called with **no session** (a direct `POST /aws-blocks/api` carrying no sign-in cookie), a note method returns a JSON-RPC **error** envelope — never a `result` and never another user's notes.

### The page (thin client / light smoke)

Once signed in, the user types a note and adds it (the add button calls `api.addNote`); each note renders in the list (from `api.listNotes`), verbatim as **text content** (never as HTML — `<b>x</b>` shows literally). After a full reload the visitor is still signed in and all notes are still listed. Disable `[data-testid=add-note-btn]` while the note input is empty or whitespace-only (trim before the check); re-enable it once real text is present.

## Selector contract

The page smoke test uses these `data-testid` hooks. Implement them exactly. The signed-out vs signed-in views are told apart by which hooks are present: the sign-in button shows only when signed out; the profile + note hooks show only when signed in. An inactive view's hooks must be **removed** from the DOM (not merely hidden with CSS).

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=signin-btn]` | `<button>` | Starts the OIDC sign-in flow; shown when signed out |
| `[data-testid=profile-sub]` | element in the signed-in view | Renders the signed-in user's subject id (non-empty) |
| `[data-testid=note-input]` | `<input>` / `<textarea>` | Where the user types a note |
| `[data-testid=add-note-btn]` | `<button>` | Adds the note (calls `api.addNote`); disabled while the input is empty/whitespace |
| `[data-testid=note-item]` | one per note | A note row; renders the note's text verbatim as text content (no HTML injection) |

A `[data-testid=note-item]` must contain the note's text. The mount point is the existing root element. Replace the template's todo UI.

## Out of scope

- Real OIDC providers / credentials (use the stub provider locally), refresh-token UX, multi-provider pickers
- Editing / deleting / sharing notes, rich text
- Realtime sync between tabs (do not add a Realtime block)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
