# AWS CDK Blocks Auth App

A frontend on CDK Blocks that exercises the `Auth` Building Block end to end:
email + password sign-up confirmed by an emailed code, groups and role-gated
methods, profile attributes, password change and sign-out everywhere. Backed by
Amazon Cognito once deployed; fully local with `npm run dev`. Vite + vanilla DOM
frontend.

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
`null`.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: Auth, KVStore, per-user todos, API |
| `src/index.ts` | Frontend: sign-up / sign-in flow and app UI |
| `test/e2e.test.ts` | Tests exercising the public, protected and role-gated API |
| `index.html` | HTML shell |

## What's Included

- **Auth (email + password)** — `users.signInWith: ['email']` and
  `caseSensitive: false`, so the email address, in any case, is what users type
  to sign up and sign in. Sign-up confirms it with a
  6-digit code, then signs the user in automatically (no second password entry).
- **Groups and custom attributes** — `editors` / `readers` groups gated with
  `auth.requireRole(context, 'editors')` (see `editorsOnly` / `readersOnly`), a
  custom `department` attribute, and attribute update / verification methods
  (`updateEmail`, `confirmAttribute`, …).
- **Optional MFA with an authenticator app** — `mfa: { mode: 'optional',
  types: ['TOTP'] }`. A user who sets one up (the `setUpTotp` and
  `verifyTotpSetup` actions of `authApi`) is asked for its 6-digit code at
  sign-in; everyone else signs in with their password alone. Locally,
  `totpVerification: 'rfc6238'` checks the codes as Cognito does, so a wrong
  setup key fails in `npm run dev` too.
- **Session management** — `changePassword`, `listDevices`,
  `forgetCurrentDevice`, `signOutEverywhere`.
- **Deny by default** — `api` is defined with `auth.protect(scope, 'api', {
  public, methods })`: its `methods` run only after the session check, with the
  signed-in `user`, and a signed-out call to anything but a `public` method
  (`ping`, `getLastCode`) gets 401 `NotAuthenticatedException`.
- **KVStore** — per-user todos keyed by `userSub` (stable for the
  user's lifetime), in `auth.protect`'s `methods`.

⚠️ Decide `users.signInWith`, `users.caseSensitive`, required attributes and custom attributes before
your first deploy: Cognito can't change them on an existing user pool. Full
`Auth` docs: `npm run docs Auth`.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
