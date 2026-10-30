# AWS Blocks App (bare)

Minimal full-stack TypeScript app with the AWS Blocks framework.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: APIs and Building Blocks |
| `src/index.ts` | Frontend: imports backend APIs directly |
| `test/e2e.test.ts` | Tests: verifies API via direct imports |
| `index.html` | HTML shell |

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with mock storage |
| `npm run dev:stop` | Stop the local dev server this app started |
| `npm run test:e2e` | Test API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run sandbox:deploy` | Deploy the backend to AWS once and exit (no watch, no dev server); for scripts and CI |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |
| `npm run destroy` | Tear down the production stack (asks first; `-- --yes` in CI) |
| `npm run secret -- set KEY` | Set a secret (also `list`, `remove KEY`) |
| `npm run typegen` | Regenerate secret/config key types (`-- --check` in CI) |

Each script is an alias of the `blocks` CLI that ships with `@aws-blocks/blocks` (for example
`"deploy": "blocks deploy"`); run `npx --no -- blocks --help` to see every command and its options.
The dev server settings (port, frontend command) are in `package.json` under `"blocks": { "dev": … }`.
`npm run destroy` asks before it deletes anything; in CI or a script, run `npm run destroy -- --yes`.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/index.ts` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend. If you do need to call the API directly (e.g. troubleshooting a deployed app), every namespace shares one endpoint — `POST /aws-blocks/api` with the export name and method in the JSON-RPC `method` field (`"api.greet"`); there are no per-namespace paths like `/aws-blocks/authApi`. See `TROUBLESHOOTING.md` in `node_modules/@aws-blocks/blocks/docs` for curl examples.
