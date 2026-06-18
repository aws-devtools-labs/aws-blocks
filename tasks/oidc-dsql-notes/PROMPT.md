# Task: OIDC Notes (DistributedDatabase)

Build a personal notes app gated by OIDC sign-in. A visitor signs in through an OIDC provider, then creates notes that belong to them and persist in a distributed SQL database across reloads.

> **Block naming:** the SQL-over-DSQL block is exported as **`DistributedDatabase`** (from `@aws-blocks/blocks`). The task is named `oidc-dsql-notes` for the DSQL engine it runs on, but in code the class is `DistributedDatabase` — there is no `DsqlDatabase` export.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

This is the `react` template — a Vite single-page app (port 3000). It ships a todo demo wired with **AuthBasic + DistributedTable + Realtime**; you will **replace** those with **AuthOIDC + DistributedDatabase** (remove the todo/realtime code you don't need). The frontend imports backend exports via `import { ... } from 'aws-blocks'`.

## Requirements

1. **OIDC sign-in.** A signed-out visitor sees a single sign-in button. Clicking it runs the OIDC sign-in flow and, on return, establishes a session.
   - Use the auth block's **`stubIdp()`** provider for zero-config local sign-in. **It defaults to an interactive account picker — for an automated flow you must auto-approve the first user:** `stubIdp({ name: '<provider>', onAuthorize: (req) => req.users[0] })`.
   - The client flow is: `const auth = await authApi.getClient(); auth.signIn('<provider>')`. `signIn()` navigates to the IdP and returns to the current page — so on page load your app must call `auth.handleRedirectCallback()` when it detects the OAuth return params, to complete the exchange.
2. **Profile.** Once signed in, show the signed-in user's stable subject id (e.g. the OIDC `userId`) in `[data-testid=profile-sub]`, and hide the sign-in button.
3. **Notes in DistributedDatabase.** A signed-in user can type a note and add it. Notes are stored in a **`DistributedDatabase`** table (create a `.sql` migration under `aws-blocks/dsql-migrations/`), scoped to the current user, and each note renders in the list.
4. **Persistence.** After a full page reload the visitor is still signed in (session cookie restored) and their notes are still listed.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md`. Read the OIDC auth block's README (especially the **`stubIdp()`** and **client-initiated PKCE** sections) and the distributed-database block's README before wiring.

Shapes you'll use (read the READMEs for exact options):

```ts
// backend — aws-blocks/index.ts
import { ApiNamespace, Scope, AuthOIDC, stubIdp, DistributedDatabase, sql } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const auth = new AuthOIDC(scope, 'auth', {
  providers: [stubIdp({ name: 'stub', onAuthorize: (req) => req.users[0] })],
});
export const authApi = auth.createApi();

const db = new DistributedDatabase(scope, 'main', { migrationsPath: './aws-blocks/dsql-migrations' });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async addNote(text: string) { const u = await auth.requireAuth(context); /* INSERT scoped to u.userId */ },
  async listNotes() { const u = await auth.requireAuth(context); /* SELECT WHERE owner = u.userId */ },
}));
```

On the frontend, import the browser-only auth helpers from `@aws-blocks/auth-common/ui` (these are client APIs — keep them out of the backend `aws-blocks/index.ts`):

```ts
// frontend — e.g. src/main.ts (browser only)
import { onAuthChange } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

// Fires with the current user on load and on every change — use it to flip
// between the signed-out and signed-in views and to restore the session after a reload.
onAuthChange(authApi, (user) => { /* render signed-out vs signed-in */ });

// On the OAuth return, complete the exchange.
const auth = await authApi.getClient();
const user = await auth.handleRedirectCallback(); // when OAuth return params are present
```

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly. The signed-out vs signed-in views are told apart by which hooks are present: the sign-in button shows only when signed out; the profile + note hooks show only when signed in.

An inactive view's hooks must be REMOVED from the DOM (the grader asserts `toHaveCount(0)`); hiding them with CSS (`display:none` / `hidden`) will fail.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=signin-btn]` | `<button>` | Starts the OIDC sign-in flow; shown when signed out |
| `[data-testid=profile-sub]` | element in the signed-in view | Renders the signed-in user's subject id (non-empty) |
| `[data-testid=note-input]` | `<input>` / `<textarea>` | Where the user types a note |
| `[data-testid=add-note-btn]` | `<button>` | Adds the note for the current user |
| `[data-testid=note-item]` | one per note | A note row; must render the note's text as its content |

A `[data-testid=note-item]` must contain the note's text (the test locates a note via `filter({ hasText: text })`).

The mount point is the existing root element. Replace the template's todo UI.

## Out of scope

- Real OIDC providers / credentials (use `stubIdp()` locally), refresh-token UX, multi-provider pickers
- Editing / deleting / sharing notes, rich text
- Realtime sync between tabs (you're removing the Realtime block)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
