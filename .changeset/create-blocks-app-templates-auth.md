---
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': minor
---

New apps now use the unified `Auth` block. Every template that signs users in (`default`, `react`, `demo`, `api-only`, `sql` and the auth template) now uses `Auth` from `@aws-blocks/blocks` instead of `AuthBasic` or `AuthCognito`. The block id stays `'auth'`.

**Sign-up now needs the emailed code.** A new account confirms its email address with a 6-digit code, then the user is signed in automatically, with no second password entry. With `AuthBasic`, users were signed in as soon as they signed up. When you run locally (`npm run dev`), no email is sent: the code is printed in the terminal, and each template's e2e tests read it from `.bb-data/`. Once deployed, Amazon Cognito emails the code. Its default sender is limited to 50 emails a day.

**The `auth-cognito` template is now `auth`.** There is one auth block now, so the template is named for what it shows: email sign-up with a code, groups with `requireRole`, profile attributes, password change and sign-out everywhere. `--template auth-cognito` still works and scaffolds `auth`. The template now signs in with email + password instead of a passwordless email code, because Cognito can only send that code through Amazon SES, which a user pool created by the block doesn't have.

The `amplify` overlay's token verifier now implements the `BlocksAuth` interface and throws the same error names as `Auth` (`NotAuthenticatedException`, `NotAuthorizedException`), and its `requireGroup()` is now `requireRole()`. The `AGENTS.md` scaffolded into every app explains how to configure `Auth`, gate methods with `requireAuth` / `requireRole`, and where the `Auth` docs live.
