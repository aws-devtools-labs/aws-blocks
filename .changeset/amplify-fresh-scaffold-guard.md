---
"@aws-blocks/create-blocks-app": patch
---

Fix + polish for `create-blocks-app`:

- Reject `--template amplify` on a fresh directory up front with a
  helpful message pointing at `--template default` (for a fresh app)
  or the no-arg command (to integrate Blocks into an existing Amplify
  Gen 2 project). The `amplify` template is an overlay auto-selected
  when the CLI detects `amplify/backend.ts`, not a scaffoldable
  starter. Previously the fresh-scaffold path with `--template amplify`
  crashed mid-copy on missing template files.
- Correct two template descriptions that misstated the frontend:
  `auth-cognito` and `demo` were labeled "Vite + lit-html" but both
  ship a Vite + vanilla-DOM frontend. Descriptions now read
  "Vite + vanilla-DOM frontend with Cognito passwordless email-OTP
  auth end-to-end" and "Fuller example — AuthBasic + KVStore +
  DynamoDB priority-sorted todo (Vite, vanilla-DOM)" respectively.
