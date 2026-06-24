# AWS Blocks App

Real-time todo app with authentication, per-user data isolation, and live sync across tabs.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: auth, data model, API, real-time channels |
| `src/index.ts` | Frontend: todo UI with live updates |
| `test/e2e.test.ts` | Tests: auth, CRUD, conflicts, real-time |
| `index.html` | HTML shell |

## What's Included

- **AuthBasic** — sign up / sign in / sign out with JWT sessions
- **DistributedTable** — todos stored in DynamoDB with Zod schema validation
- **Optimistic locking** — `version` field + `ifFieldEquals` prevents lost updates
- **Realtime** — todo changes broadcast to all connected tabs via WebSocket

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with mock storage |
| `npm run test:e2e` | Test API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |

## Building on this template

The test file (`test/e2e.test.ts`) is structured in sections — Auth, CRUD, Conflicts, Realtime. Add your own tests by copying a `test(...)` block and changing the assertion. The API methods in `aws-blocks/index.ts` follow a consistent pattern: authenticate → do work → broadcast.

To replace the todo domain with your own: update the Zod schema, rename the API methods, and adjust the tests. The auth and real-time wiring stays the same.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/index.ts` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend.
