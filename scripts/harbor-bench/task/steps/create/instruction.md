# Create a todo app with AWS Blocks

Build a working todo app in `/app/todo-app` with AWS Blocks. Create the project with the AWS Blocks app scaffolder using its `bare` template, then build the app in local mock mode. Later requests will extend this same app.

Store todos with AWS Blocks and expose them through a typed `ApiNamespace`; don't use browser storage, your own files or server, or in-memory state. No login is needed.

Don't deploy, call AWS, inspect credentials or print environment variables; the model credentials are only for your own Bedrock calls. Don't change npm configuration or edit installed packages. Don't inspect or modify `/tests`, `/logs`, `/opt/bench` or `/var/lib/harbor-verifier`.

## UI contract

`npm run build` must succeed, and `npm run dev` in `/app/todo-app` must serve the app at `http://localhost:3000`. An external browser test uses these exact accessible labels and test IDs:

- Text input labelled **Todo title**, button **Add todo**.
- One `data-testid="todo-item"` container per todo, showing its title.
- In each item: checkbox labelled **Completed**, text input labelled **Edit title**, buttons **Save todo** and **Delete todo**.

Adding, listing, editing the title, toggling completion both ways and deleting must work through the backend, and survive a page reload, a fresh browser and a server restart. Stop any servers you started before finishing.

Playwright with Chromium is preinstalled for browser testing: `import { chromium } from '/opt/playwright/index.mjs'`.
