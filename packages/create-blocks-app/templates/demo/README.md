# Blocks Demo App

A fuller example app on AWS Blocks. It wires together several Building Blocks in
one place so you can see how they fit: `AuthBasic` for sign-in, a `KVStore` for
loose key/value data, and a `DistributedTable` for a sortable, per-user
todo list. Vite + vanilla DOM frontend, no framework.

> Created with `npx @aws-blocks/create-blocks-app my-app --template demo`

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
| `aws-blocks/index.ts` | Backend: auth, KVStore, todo table, API methods |
| `src/index.ts` | Frontend: sign-in, key/value demo, sortable todo UI |
| `test/e2e.test.ts` | Tests exercising the public and protected API |
| `index.html` | HTML shell |

## What's Included

- **AuthBasic** — sign up / sign in / sign out with JWT sessions.
- **KVStore** — a public `getValue` / `setValue` pair plus a cookie round-trip
  demo (`setCookie` / `getCookie` / `deleteCookie`).
- **DistributedTable** — per-user todos; `listTodos(sortBy)` sorts the list in
  the API (an in-memory sort, no secondary indexes to provision). Every todo
  method calls `auth.requireAuth(context)`, so data is isolated per user.

The API mixes **public** methods (no auth) and **protected** methods (gated by
`requireAuth`) in one namespace, showing where the auth boundary sits.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with mock storage |
| `npm run test:e2e` | Test the API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |
| `npm run destroy` | Tear down the production stack |

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in
`.blocks/config.json`, generated at scaffold time from your project name plus a
random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod`
and sandbox as `<stackId>-<username>-<random>`. To rename, edit `stackId`, or
`aws-blocks/index.cdk.ts` for dynamic naming logic.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all
data persistence and cloud abstractions (they mock locally and deploy to AWS
automatically). Start in `aws-blocks/index.ts` (backend) and `src/index.ts`
(frontend). Test via `npm run test:e2e`.
