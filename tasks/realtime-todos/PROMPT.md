# Task: Realtime To-Do List

Scaffold a fresh AWS Blocks app, then build a to-do list page in it. The page must work across multiple browser tabs in real time and survive a page reload.

## Setup (do this first)

You start in an empty workspace. Call **`scaffold_app`** before anything else — it creates `./bench-app/` with the project skeleton and runs `npm install` for you. After that, do all your edits inside `bench-app/`. When you want to verify against a running app, call **`start_dev_server`** — it boots `npm run dev` and returns the base URL. Don't try to run the dev server through `run_bash`.

## Requirements

1. A user can type into an input and click a button to add a new to-do item.
2. The list shows every to-do that has been added.
3. Each item has a checkbox that toggles its done state.
4. Each item has a button that removes it from the list.
5. **Realtime:** when one tab adds, toggles, or removes a to-do, every other open tab reflects the change within a couple of seconds — no manual refresh.
6. **Persistence:** after a full page reload, the to-dos are still there.

The to-dos are shared across all tabs of the app (single global list). No login, no users, no per-user filtering.

## Where to look

The project is built on AWS Blocks. Inside `bench-app/`, the `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Inside `bench-app/node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. Read the relevant ones before deciding which building blocks to use.

You will need at least one block for stored data and at least one block for the realtime sync. Pick whichever ones fit the requirements; you may use as many or as few as you need.

After `start_dev_server` returns, the running app is at <http://localhost:3000>. Edits to `bench-app/aws-blocks/` reload the backend; edits under `bench-app/src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using `data-testid` and one data attribute. These are the only DOM hooks the test relies on — implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=todo-input]` | `<input type="text">` | Where the user types a new to-do title |
| `[data-testid=todo-add]` | `<button>` | Click to add the value of the input as a new to-do |
| `[data-testid=todo-list]` | `<ul>` (or any single container) | Wraps every to-do item |
| `[data-testid=todo-item]` | one per to-do, inside the list | The row for a single to-do |
| `[data-testid=todo-title]` | inside the item | Renders the to-do's title text |
| `[data-testid=todo-toggle]` | `<input type="checkbox">` inside the item | Toggles done/not-done |
| `[data-testid=todo-delete]` | `<button>` inside the item | Removes that to-do |

When a to-do is done, set `data-done="true"` on its `[data-testid=todo-item]` element. When not done, either omit the attribute or set it to `"false"`.

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user lists
- Styling beyond what makes the test pass (no design pass needed)
- Editing a to-do's title after creation
- Ordering, sorting, filtering, search
- Animations, drag-and-drop
- Pagination or virtualization

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes are limited to files inside `bench-app/`. Don't modify anything under `bench-app/node_modules/`.
