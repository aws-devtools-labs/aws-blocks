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
  non-positive amount, which previously slipped past the overdraft guard, and
  an amount that is not a finite number (a numeric string passed `> 0`).
- The `demo` template's `searchDocs` now calls `auth.requireAuth(context)`: on
  deploy each query is a billed Bedrock retrieval.
- The `demo` and `auth-cognito` templates' `updateTodo` copies only `completed`,
  `priority` and `title` from `updates`. It spread the whole argument, so a
  caller could set the owner key and write a todo into another user's list.
- Adding Blocks to an existing project (or an Amplify Gen 2 app) now appends
  `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`,
  `credentials` files (not `credentials/` directories), and `.aws/` to its
  `.gitignore`, the same patterns the templates ship. Entries are compared as
  whole lines, so an existing `.env.local` no longer stops `.env` being added.
  The `.env.example` / `credentials/` exceptions are left out when the project's
  own `.gitignore` could already ignore those names, so they never un-ignore them.
  A project that un-ignores `.env` (`!.env`) gets `.env` ignored again, and
  `.env.*` also ignores new `.env.development` / `.env.production` files (files
  git already tracks stay tracked). The plan and the `Modified .gitignore` line
  now list the entries added, and a CRLF `.gitignore` keeps CRLF line endings.
- The `api-only` and `demo` templates keep FileBucket versioning on (the
  default), so an overwritten or deleted file can be restored, and the
  `api-only` template's `createUploadUrl` and the `demo` template's
  `getUploadSlot` sign only an explicit list of content types
  (`ALLOWED_UPLOAD_TYPES`).
