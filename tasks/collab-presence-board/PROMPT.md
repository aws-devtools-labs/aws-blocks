# Task: Collaborative Presence Board

Build a shared presence board in this AWS Blocks app. Each visitor picks a name and "joins"; everyone with the app open sees the live roster of who's present, updated in real time. The roster also survives a page reload.

The shared board itself — registering, deduping, storing, and reading back the roster — must run through an **`api` namespace** backed by real framework blocks (a **distributed-table** block for the durable roster, a **realtime** block for fan-out). The page is a thin client over that API plus the realtime channel.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

### The `api` namespace (authoritative shared board)

Expose an **`api` namespace** (the framework's server-side RPC surface — `POST /aws-blocks/api`) with:

- **`api.join(name)`** — registers `name` on the shared board (persisting it via the **distributed-table** block) and broadcasts the change over the **realtime** block. **Keyed by name:** joining a name that is already present must **not** create a duplicate — the roster holds at most one entry per name. The name is stored and returned **verbatim** (a name like `<b>x</b>` is preserved literally as text; non-ASCII / emoji preserved exactly). A blank or whitespace-only `name` is rejected with a JSON-RPC **error** envelope and does not change the roster.
- **`api.listPresent()`** — returns the current shared roster as an array `[{ name }]` read from the store. Because the roster is persisted, a fresh caller (or a freshly-loaded tab) sees everyone who has joined — not a blank board.

### Realtime + persistence
1. **Realtime:** when one tab/visitor joins, every other open tab reflects the new presence within a couple of seconds — no manual refresh (driven by the realtime block's broadcast).
2. **Persistence / first paint:** on load the page fetches the stored roster via `api.listPresent()` and renders it, so a tab opened *after* others joined sees them immediately, and a reload restores the whole shared roster.

### Chat UI (thin client / light smoke)
3. A visitor sees a name field `[data-testid=presence-name-input]` and a join button `[data-testid=join-btn]`. Submitting the name calls `api.join`; a `[data-testid=presence-item]` row appears for each present visitor, rendering that visitor's name.
4. **Input validation:** disable `[data-testid=join-btn]` whenever the name field is empty or whitespace-only (trim before the check); re-enable it once a real name is present.
5. **Untrusted names:** render visitor names as **text**, never as markup — a name like `<b>x</b>` must appear literally and must not create a real `<b>` element (no `innerHTML` injection).

A single shared board across all tabs — no login, no per-user filtering.

## Selector contract

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=presence-name-input]` | `<input type="text">` | Where the visitor types their presence name |
| `[data-testid=join-btn]` | `<button>` | Registers the typed name (`api.join`) on the shared board |
| `[data-testid=presence-item]` | one per present visitor | The row for a single present visitor; renders the name as its text |

Each `[data-testid=presence-item]` must render the visitor's name as its text (the test locates a visitor by `filter({ hasText: name })`).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user boards
- Real cursor (x/y) tracking, avatars, colors — a named presence row is enough
- Leaving/timeout/heartbeat semantics — joining and seeing the live roster is the requirement
- Styling beyond what makes the test pass
- Ordering, sorting, filtering, search, pagination

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
