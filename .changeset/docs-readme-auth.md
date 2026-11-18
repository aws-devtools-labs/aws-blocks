---
"@aws-blocks/bb-auth": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/blocks": patch
---

docs(bb-auth, auth-common): the `Auth` README opens with a quick start and has tables for its options, its error statuses and local versus AWS behaviour; the `auth-common` README lists every `AuthErrors` name.

**`Auth` (`packages/bb-auth/README.md`)**

- Corrected: the README said existing `AuthCognito` sessions are accepted. They are not: `Auth` reads a new session store, and every user signs in once after the switch.
- Corrected: the `ttlSeconds` default reads "30 days", without the former value.
- Corrected: `rememberDevice` on AWS throws a `501`; the README now also names the error, `InvalidParameterException`.
- Added: `## Quick start`, with the backend file (`new Auth`, `createApi()`, one guarded method) and the frontend mount (`AccountMenuBar`, `AuthenticatedContent`), and the rule that exporting `authApi` does not render a login screen.
- Added: `### Options`, a table of every top-level option with its type and default, and of the nested options that had no table. The `session` table gains `freshAgeSeconds` and `crossDomain`.
- Added: `## Errors`, with the default HTTP status of each error name, the three statuses that differ, the retriable names, and where each matcher is imported from (`isAuthError` and `AuthErrors` from `@aws-blocks/blocks` on the server; `isBlocksError` and `hasAuthError` from `@aws-blocks/blocks/client` in the browser).
- Added: a table of what an app observes locally and on AWS at the top of `## Local development`, a table of the server-side errors of a gated call in `## Mode gates` (two rows are new: `EmailPasswordNotEnabledException` and `NoFederatedProviderException`, both 409), and a table of the feature-plan rates.
- Moved within the file: `## Usage` and `## Which option and why` come before `## Recipes`; "What is checked when" is in `## Mode gates`; the stub IdP has its own heading, `### The stub IdP (stubIdp())`.
- Replaced: `## What it does` is now `## Sign-out and password reset`, `## Bearer tokens (allowBearerAuth)` and `## Changes the block refuses`. `## One sign-up and sign-in policy: validateUser` is now `## validateUser`.
- Removed: mentions of the former `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks in reference text (the migration section still points to `MIGRATION.md`), and the `## Design` section (the introduction links to `DESIGN.md`).

**`packages/bb-auth/MIGRATION.md` and `CUSTOMIZING-AUTH-UI.md`**

- Corrected: `MIGRATION.md` said the default session lifetime is 400 days in `Auth`. It is 30 days.
- Added: `CUSTOMIZING-AUTH-UI.md` says that `submitAuthAction(authApi, { action: 'signOut' })` type-checks as written and needs no `as any`.

**`auth-common` (`packages/auth-common/README.md`)**

- Corrected: Theming named three components that inject the stylesheet. Each of the five components does.
- Added: a table of all 44 `AuthErrors` names with their constant and meaning.
- Added: `## Exports` says that application code imports the UI from `@aws-blocks/blocks/ui`. `submitAuthAction` says that it and `setAuthState` are fully typed, so a custom form needs no `as any`.
- Moved within the file: `## Types Reference` comes before `## Custom auth UI: submitAuthAction`; `## Session-cookie security policy (/cookies)` is at the end, as a function table plus a list.
- Removed: the server-side `AuthErrors` example that repeated `getCurrentUser` (a client-side catch replaces it), all but one guard in the `BlocksAuth` example (the method table lists the others), and descriptions of how the components and the auth-state store work underneath.
