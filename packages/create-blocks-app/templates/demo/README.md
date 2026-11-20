# AWS CDK Blocks Demo App

An example app on CDK Blocks that wires together `Auth`, `KVStore`,
`FileBucket`, `AppSetting`, `Secret`, `EmailClient`, `AsyncJob`,
`KnowledgeBase`, `Database` and cookies. Vite + vanilla DOM frontend, no framework.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

## Before deploying to production

Replace the `EMAIL_SENDER` constant in `cdk-blocks/index.ts` with a verified
SES identity. Its placeholder works locally (the mock sends nothing), but it is
on the reserved `.invalid` domain, which SES can never verify, so every send
from it fails on AWS. Synth warns
(`@aws-cdk-blocks/bb-email-client:UnverifiableSender`) until you do.

This is a demo, not a production authorization model. Use only dummy values
with the API-key rotation example. Before exposing the app to real users,
remove the RPC methods that return credentials, restrict shared settings and
key rotation to trusted operators, and restrict who can send email and to whom.
Being signed in is not sufficient authorization for these operations.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: auth, KVStore, todo table, API methods |
| `src/index.ts` | Frontend: sign-in, key/value demo, sortable todo UI |
| `test/e2e.test.ts` | Tests exercising the public and protected API |
| `index.html` | HTML shell |

## What's Included

- **Auth** — email + password sign-up / sign-in / sign-out with server-side
  sessions (Amazon Cognito on AWS). Sign-up confirms the email address with a
  6-digit code; locally the code is printed in the `npm run dev` terminal.
- **KVStore** — a `getValue` / `setValue` pair gated by `requireAuth`, with
  keys namespaced per user.
- **Cookies** — a public round-trip demo (`setCookie` / `getCookie` /
  `deleteCookie`) on a single fixed-name `HttpOnly; SameSite=Lax` cookie. It is
  also `Secure` except on plain-HTTP localhost, the same rule as the auth cookie.
- **FileBucket** — upload/download gated by `requireAuth`, with paths scoped
  per user; `getUploadSlot` signs only the content types in
  `ALLOWED_UPLOAD_TYPES`.
- **AppSetting** — `setFlag` calls `requireAuth`; `getFlag` stays public.
- **Secret** — the API-key rotation methods, gated by `requireAuth`.
- **EmailClient** — `sendWelcome`, gated by `requireAuth`. Its sender is
  `EMAIL_SENDER` (see "Before deploying to production").
- **AsyncJob** — `runGreetingJob` calls `requireAuth`; `jobRan` stays public.
- **KnowledgeBase** — `searchDocs`, gated by `requireAuth`.
- **KVStore with a `schema` and a `key`** — per-user todos;
  `listTodos(sortBy)` sorts the list in
  the API (an in-memory sort, no secondary indexes to provision). Every todo
  method calls `auth.requireAuth(context)`, so data is isolated per user.
- **Database** — an atomic SQL money `transfer` between accounts; both
  balance updates commit together or roll back together inside one transaction.
  Accounts belong to the signed-in user (an `owner` column every query filters
  on), so a caller can only move money between their own accounts.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
