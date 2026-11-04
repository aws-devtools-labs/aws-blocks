---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat: the frontend reads generated backend types instead of typechecking backend source

Importing `aws-blocks` in a frontend made the frontend's TypeScript typecheck the backend's source with the frontend's tsconfig. Frontend configs often hide Node types or use browser-only settings — Vite's sets `"types": ["vite/client"]` — so backend code that uses `process` or `node:crypto` failed the frontend build.

New apps now generate the backend's declaration files into `aws-blocks/.types/` with a backend-only `aws-blocks/tsconfig.types.json`, and `aws-blocks/package.json` points `exports["."].types` at them. A frontend whose tsconfig excludes `aws-blocks/` then reads those files instead of the backend source.

- `blocks-generate-client` (the `prebuild` and `pretypecheck` hooks) writes the declarations after `client.js` and fails on backend type errors.
- Scaffolding generates them once after `npm install`, so an editor or a bare `npm run typecheck` sees them before the first `dev` or `build`.
- The dev server regenerates them each time it restarts after a backend change.
- Adding Blocks to an existing project adds `"aws-blocks"` to the frontend tsconfig's `exclude` when its `include` would cover the backend (Next.js, `tsc --init`), keeping the file's comments. It prints a manual step if it can't edit the file.
- `@aws-blocks/core/scripts` exports `generateBackendTypes`. Generation runs the app's own `tsc`, so it works with TypeScript 5.x and 7.

**Breaking for apps scaffolded before this change.** Generated types are now the only supported layout, so a backend workspace that still points `exports["."].types` at `./index.ts`, or that has no `aws-blocks/tsconfig.types.json`, fails with the migration steps instead of carrying on. It is a hard error on purpose: carrying on means the frontend keeps typechecking the backend source — the bug this fixes — without saying so.

To migrate an existing app:

1. Copy `aws-blocks/tsconfig.types.json` from a newly created app.
2. Set `exports["."].types` in `aws-blocks/package.json` to `./.types/index.d.ts`.
3. Add `aws-blocks/.types/` to `.gitignore`.
4. Run `npx blocks-generate-client`.
