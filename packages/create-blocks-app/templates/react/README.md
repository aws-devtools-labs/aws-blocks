# AWS Blocks App (React)

Real-time todo app with React, authentication, per-user data isolation, and live sync across tabs.

## Getting Started

```bash
npm run dev          # Start dev server + React frontend
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:5173 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: auth, data model, API, real-time channels |
| `src/App.tsx` | Frontend: React todo UI with live updates |
| `src/main.tsx` | React entry point |
| `test/e2e.test.ts` | Tests: auth, CRUD, conflicts, real-time |

## What's Included

- **AuthBasic** — sign up / sign in / sign out with JWT sessions
- **DistributedTable** — todos stored in DynamoDB with Zod schema validation
- **Optimistic locking** — `version` field + `ifFieldEquals` prevents lost updates
- **Realtime** — todo changes broadcast to all connected tabs via WebSocket

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Backend + React dev server (concurrent) |
| `npm run test:e2e` | Test API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run deploy` | Full production deploy |

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<sandboxId>`, where `sandboxId` is a per-machine random ID stored in `.blocks-sandbox/sandbox-id` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/App.tsx` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend.
