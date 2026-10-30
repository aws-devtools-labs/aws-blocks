---
'@aws-blocks/create-blocks-app': minor
---

New apps now create a user pool where users sign in with their email address, matched ignoring case: every template that constructs `Auth` passes `users: { signInWith: ['email'], caseSensitive: false }`. Cognito fixes both settings when the pool is created, and this is the pool shape Amplify's client libraries expect, so an app can add an Amplify frontend later without a new pool. The email is now the username: sign-up asks for an email address and no separate username, and the UI shows the user's email. The scaffolded `AGENTS.md` explains the shape and that it can't change after the pool exists.
