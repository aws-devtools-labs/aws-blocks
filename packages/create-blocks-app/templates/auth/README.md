# Blocks Auth App

A frontend on AWS Blocks that exercises the `Auth` Building Block end to end:
email + password sign-up confirmed by an emailed code, groups and role-gated
methods, profile attributes, password change and sign-out everywhere. Backed by
Amazon Cognito once deployed; fully local with `npm run dev`. Vite + vanilla DOM
frontend.

> Created with `npx @aws-blocks/create-blocks-app my-app --template auth`
> (`--template auth-cognito`, this template's former name, still works).

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

**Local codes:** locally no email is sent. Every verification code (sign-up,
password reset, email change) goes to the `codeDelivery` hook, which prints it
in the `npm run dev` terminal and keeps it for the local-only `getLastCode`
method, so the page can show it ("Show last code"). Once deployed, Cognito
emails the codes instead: the hook never runs there and `getLastCode` returns
`null`. Cognito's default sender is limited to 50 emails a day.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: Auth, KVStore, per-user todos, API |
| `src/index.ts` | Frontend: sign-up / sign-in flow and app UI |
| `test/e2e.test.ts` | Tests exercising the public, protected and role-gated API |
| `index.html` | HTML shell |

## What's Included

- **Auth (email + password)** — `users.signInWith: ['email']`, so the email
  address is what users type to sign up and sign in. Sign-up confirms it with a
  6-digit code, then signs the user in automatically (no second password entry).
- **Groups and custom attributes** — `editors` / `readers` groups gated with
  `auth.requireRole(context, 'editors')` (see `editorsOnly` / `readersOnly`), a
  custom `department` attribute, and attribute update / verification methods
  (`updateEmail`, `confirmAttribute`, …).
- **Session management** — `changePassword`, `listDevices`,
  `forgetCurrentDevice`, `signOutEverywhere`.
- **DistributedTable** — per-user todos keyed by `userSub` (stable for the
  user's lifetime), gated by `auth.requireAuth(context)`.

⚠️ Decide `users.signInWith`, required attributes and custom attributes before
your first deploy: Cognito can't change them on an existing user pool. Full
`Auth` docs: `node_modules/@aws-blocks/bb-auth/README.md`.

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
