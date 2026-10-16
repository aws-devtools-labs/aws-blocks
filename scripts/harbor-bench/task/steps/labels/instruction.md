# Extend the existing todo app: labels

Continue the same `/app/todo-app`, installed packages, and conversation. Do not re-scaffold or clear persisted data. Preserve all existing todos, completion flags, titles, and due dates. Re-read the app AGENTS and installed block docs as needed.

Add multiple labels to each todo. Within each `data-testid="todo-item"`, provide a text input labelled **Labels**, containing a comma-separated list. Clicking that item's existing **Save todo** saves labels along with its edited title and due date. Trim label whitespace, ignore empty entries, and deduplicate. Clearing the input and saving removes every label. Display each saved label in an element with `data-testid="todo-label"` within the item. Labels, due dates, and completion must survive browser reload, a fresh browser context, and full server restart. Old items lacking labels should work without a migration that loses data.

The final verifier exercises all three phases (CRUD, completion, due-date editing/clearing, label editing/clearing) and checks data it created in previous phases. Keep `npm run build` and `npm run dev` at http://localhost:3000 working. No deployment, account discovery, credential inspection, npm config changes, installed-package edits, or verifier-file inspection. Stop any development server before finishing.
