---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): gate the remaining public template methods and git-ignore secrets when adding Blocks to an existing project

- The `api-only` template's `createUploadUrl` / `createDownloadUrl` now call
  `auth.requireAuth(context)` and scope the path to the caller, so a signed-out
  caller can no longer mint presigned URLs to read or write any file in the
  bucket.
- The `demo` template's SQL ledger methods (`openAccount`, `balanceOf`,
  `transfer`) now call `auth.requireAuth(context)`, and accounts belong to the
  signed-in user (a new `owner` column in `accounts`), so a caller can only
  read and move money between their own accounts. `transfer` declines a
  non-positive amount, which previously slipped past the overdraft guard.
- The `demo` template's `searchDocs` now calls `auth.requireAuth(context)`: on
  deploy each query is a billed Bedrock retrieval.
- Adding Blocks to an existing project (or an Amplify Gen 2 app) now appends
  `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`,
  `credentials` files (not `credentials/` directories), and `.aws/` to its
  `.gitignore`, the same patterns the templates ship. Entries are compared as
  whole lines, so an existing `.env.local` no longer stops `.env` being added.
