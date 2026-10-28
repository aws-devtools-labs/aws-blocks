---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat: the frontend reads generated backend types instead of typechecking backend source

Importing `aws-blocks` in a frontend made the frontend's TypeScript typecheck the backend's source with the frontend's tsconfig. Frontend configs often hide Node types or use browser-only settings — Vite's sets `"types": ["vite/client"]` — so backend code that uses `process` or `node:crypto` failed the frontend build.

New apps now generate the backend's declaration files into `aws-blocks/.types/` with a backend-only `aws-blocks/tsconfig.types.json`, and `aws-blocks/package.json` points `exports["."].types` at them. The frontend reads those files and never checks the backend source.

- `blocks-generate-client` (the `prebuild` hook) writes the declarations after `client.js` and fails on backend type errors.
- The dev server regenerates them each time it restarts after a backend change.
- Adding Blocks to an existing project adds `"aws-blocks"` to the frontend tsconfig's `exclude` when its `include` would cover the backend (Next.js, `tsc --init`), keeping the file's comments. It prints a manual step if it can't edit the file.
- `@aws-blocks/core/scripts` exports `generateBackendTypes`. Generation runs the app's own `tsc`, so it works with TypeScript 5.x and 7.

Existing apps are unchanged: generation only runs for a workspace whose `exports["."].types` is a `.d.ts` path. To opt in, copy `aws-blocks/tsconfig.types.json` from a new app, set `exports["."].types` to `./.types/index.d.ts`, add `aws-blocks/.types/` to `.gitignore`, and run `npx blocks-generate-client`.
