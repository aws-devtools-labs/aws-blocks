# Blocks Auth (Cognito) App

A frontend on AWS Blocks with **passwordless email-OTP** authentication end to
end, backed by Amazon Cognito. Sign up and sign in with just an email address
and a one-time code — no password. Vite + vanilla DOM frontend.

> Created with `npx @aws-blocks/create-blocks-app my-app --template auth-cognito`

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

**Local OTP:** in mock/dev there is no real mailbox, so the one-time code is
captured and exposed via the `getLastCode` API method (and logged to the
console) for the UI to display. This capture is disabled in sandbox/production —
gated on the `BLOCKS_STACK_NAME` env var — where Cognito delivers codes by
email.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: AuthCognito, KVStore, per-user todos, API |
| `src/index.ts` | Frontend: OTP sign-up / sign-in flow and app UI |
| `test/e2e.test.ts` | Tests exercising the public and protected API |
| `index.html` | HTML shell |

## What's Included

- **AuthCognito (passwordless email-OTP)** — `authFlowType: 'USER_AUTH'` +
  `preferredChallenge: 'EMAIL_OTP'` + `signInWith: 'email'`, so a user signs in
  by entering an email and a code. Auto sign-in after sign-up confirmation means
  no second code.
- **Groups and custom attributes** — `editors` / `readers` groups (see
  `editorsOnly` / `readersOnly`), a custom `department` attribute, and attribute
  update / verification methods (`updateEmail`, `confirmAttribute`, …).
- **Session management** — `changePassword`, `listDevices`,
  `forgetCurrentDevice`, `signOutEverywhere`.
- **DistributedTable** — per-user todos keyed by `userSub` (stable across
  username changes), gated by `auth.requireAuth(context)`.

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
