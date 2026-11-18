---
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/create-blocks-app': patch
---

docs: fix two stale references

- The FileBucket README's access-control examples construct `new Auth(scope, 'auth')` (from `@aws-blocks/bb-auth`) instead of the removed `AuthBasic`.
- The scaffolded `AGENTS.md` no longer says to import `ApiError` and the typed client from `@aws-blocks/blocks`, whose browser build exports nothing: `ApiNamespace` comes from `@aws-blocks/blocks` in the backend, and `ApiError` / `isBlocksError` from `@aws-blocks/blocks/client` in frontend code and tests.
