# Extend the existing todo app: due dates

Continue the same `/app/todo-app`, framework installation, and conversation. Do not re-scaffold, replace package versions, clear `.bb-data`, or discard existing todos. Re-read the app AGENTS and installed block docs as needed. All phase 1 behavior and data must keep working.

Add an optional due date to each todo, editable and clearable after creation. Within every `data-testid="todo-item"`, provide an HTML date input labelled **Due date**. Clicking that item's existing **Save todo** saves both the edited title and due date. The date input must display the saved `YYYY-MM-DD` value; clearing it and saving removes the date. Existing todos without dates still render and remain editable. Persist due dates through AWS Blocks, including across browser reload, fresh browser context, full server restart, and the next phase.

Keep `npm run build` and `npm run dev` (http://localhost:3000) working. The external verifier reruns all prior CRUD behavior and checks its previously created data. No deployment, account discovery, credential inspection, npm config changes, installed-package edits, or verifier-file inspection. Stop any development server before finishing.
