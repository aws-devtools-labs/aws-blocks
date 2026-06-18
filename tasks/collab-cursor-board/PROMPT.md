# Task: Collaborative Presence Board

Build a shared presence board in this AWS Blocks app. Each visitor picks a name and "joins"; everyone with the app open sees the live roster of who's present, updated in real time. The roster also survives a page reload.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

1. A visitor sees a name field and a join button.
2. Submitting the name registers the visitor on the shared presence board and adds a row for them. Presence is **keyed by name**: joining with a name that is already present does **not** create a duplicate row — the board shows at most one row per name.
3. **Realtime:** when one tab/visitor joins, every other open tab reflects the new presence within a couple of seconds — no manual refresh.
4. The presence row for a given visitor renders that visitor's name.
5. **Persistence:** the board is stored so that after a full page reload **every** present visitor is still shown — restore the whole shared roster, not just the visitor who joined in this tab. A freshly-opened tab must also load the current roster on first paint (fetch the stored board on load): a tab opened *after* others joined sees them immediately, not a blank board that only fills in on the next realtime event.
6. **Input validation:** disable `[data-testid=join-btn]` whenever the name field is empty or whitespace-only (trim before the check); re-enable it once a real name is present.
7. **Untrusted names:** names are visitor-supplied — render them as **text**, never as markup. A name like `<b>x</b>` must appear literally as text and must not create a real `<b>` element (no `innerHTML` injection). Non-ASCII and emoji names (e.g. `日本語 🙂`) must render correctly as text.

A single shared board across all tabs — no login, no per-user filtering.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. Read the relevant ones before deciding which building blocks to use.

This template already wires up a realtime channel block and a structured-data table block — exactly the two capabilities this task needs: one block to broadcast presence changes to connected clients, and one block to persist the board so it survives a reload. Adapt the scaffolded blocks to a single shared board (this task has no auth or per-user channels). Read the relevant block READMEs before wiring.

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=presence-name-input]` | `<input type="text">` | Where the visitor types their presence name |
| `[data-testid=join-btn]` | `<button>` | Registers the typed name on the shared board |
| `[data-testid=presence-item]` | one per present visitor | The row for a single present visitor |

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
