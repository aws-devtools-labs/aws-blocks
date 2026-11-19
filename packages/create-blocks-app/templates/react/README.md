# AWS CDK Blocks App (React)

Real-time todo app with React, authentication, per-user data isolation, and live sync across tabs.

## Getting Started

```bash
npm run dev          # Start dev server + React frontend
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`. The dev server serves the React frontend and the backend (`/cdk-blocks/*`) from a single origin.

**Signing up locally:** sign-up confirms the email address with a 6-digit code. Locally no email is sent, so the code is printed in the `npm run dev` terminal (`[auth] signUp code for …`). Enter it and you are signed in.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: auth, data model, API, real-time channels |
| `src/App.tsx` | Frontend: React todo UI with live updates |
| `src/main.tsx` | React entry point |
| `test/e2e.test.ts` | Tests: auth, CRUD, conflicts, real-time |

## What's Included

- **Auth** — email + password sign-up / sign-in / sign-out with server-side sessions (Amazon Cognito on AWS)
- **KVStore** — todos stored in DynamoDB with Zod schema validation
- **Optimistic locking** — `version` field + `ifFieldEquals` prevents lost updates
- **Realtime** — todo changes broadcast to all connected tabs via WebSocket

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## Stack naming

A sandbox stack's name ends in an identifier that is per machine, stored in `.cdk-blocks-sandbox/sandbox-id.txt` (gitignored). `AGENTS.md` describes the stack names and how to rename them.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
