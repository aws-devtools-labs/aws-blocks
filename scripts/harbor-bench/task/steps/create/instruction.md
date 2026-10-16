# Create a local todo application with AWS Blocks

Build a real working app in `/app/todo-app`. This is phase 1 of a three-phase task; later requests extend this same app and conversation. No application deployment, AWS calls, account discovery, or credential inspection is needed or permitted. Model credentials are only for Claude's Bedrock calls. Do not print environment variables or credentials.

First read `/home/node/.claude/skills/aws-blocks/SKILL.md`. You must scaffold the app yourself using the selected local package, not hand-create a framework or copy a finished todo template:

```sh
mkdir -p /app/bootstrap
cd /app/bootstrap
npm init -y
npm install --save-exact @aws-blocks/create-blocks-app@latest
cd /app
node /app/bootstrap/node_modules/@aws-blocks/create-blocks-app/dist/index.js todo-app --template bare --yes
```

The isolated npm configuration already routes every `@aws-blocks/*` package to this run's registry. Do not change npm configuration, use public Blocks packages, edit installed packages, or use workspace/file links. Keep bootstrap/package-lock.json and the installed scaffolder. Read the scaffolded `AGENTS.md`, `node_modules/@aws-blocks/blocks/README.md`, and relevant block documentation before implementing. Preserve the scaffolded app's `AGENTS.md` and normal Blocks build/development scripts. Use Blocks persistence and typed `ApiNamespace` RPC; never implement persistence with frontend localStorage/IndexedDB, raw files, in-memory arrays, or your own server. Use local mock mode only. This intentionally local-only app needs no login UI.

## Observable UI contract

Serve the app at `http://localhost:3000` with `npm run dev` from `/app/todo-app`. `npm run build` must succeed. Use semantic controls with these exact accessible labels / test IDs so the external browser verifier can operate the app:

- Text input labelled **Todo title**, button **Add todo**.
- One visible container `data-testid="todo-item"` per item, displaying its title.
- Within each item: checkbox labelled **Completed**, text input labelled **Edit title**, button **Save todo**, button **Delete todo**.
- Add, list, edit title, toggle completion (both directions), and delete must work through the backend.
- Items and their completion state survive browser reload, a new browser context (no previous storage/cookies), and a full local server restart.

The verifier will create items after you finish. Do not clear persisted `.bb-data` or existing todos in later phases. Do not hardcode test data. You may test your app locally; run servers in a background tmux session and stop them before finishing. Do not inspect or modify `/tests`, `/logs`, `/opt/bench`, or `/var/lib/harbor-verifier`. Deliver working code, not screenshots or a plan.
