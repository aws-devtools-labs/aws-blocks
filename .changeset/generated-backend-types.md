---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat: the frontend reads generated backend types instead of typechecking backend source

Importing `aws-blocks` in a frontend made the frontend's TypeScript typecheck the backend's source with the frontend's tsconfig. Frontend configs often hide Node types or use browser-only settings — Vite's sets `"types": ["vite/client"]` — so backend code that uses `process` or `node:crypto` failed the frontend build.

New apps now generate the backend's declaration files into `aws-blocks/.types/` with a backend-only `aws-blocks/tsconfig.types.json`, and `aws-blocks/package.json` points `exports["."].types` at them. A frontend whose tsconfig excludes `aws-blocks/` then reads those files instead of the backend source.

- `blocks-generate-client` (the `prebuild` and `pretypecheck` hooks) writes the declarations after `client.js` and fails on backend type errors.
- A new `blocks-generate-types` bin writes only the declarations, and is every app's `prepare` script. `aws-blocks/.types/` is gitignored, so `prepare` is what makes it exist after scaffolding, after a clone, and in CI — npm runs it on a bare `npm install` and on `npm ci`. It never fails an install: its job is to make the types exist, and `prebuild`/`pretypecheck` remain the gate that fails a build. (`svelte-kit sync` uses `prepare` the same way; `astro sync` runs as part of `astro dev`/`build`/`check`.)
- The dev server regenerates them each time it restarts after a backend change.
- Adding Blocks to an existing project now wires `prepare`, `prebuild` and `pretypecheck` too, and adds `typescript` to devDependencies — without a hook, that path never generated the declarations at all, and a missing `exports["."].types` target falls back to the backend source silently. Scripts the host project already defines are left alone.
- Adding Blocks to an existing project also *reports* a frontend tsconfig whose `include` would cover the backend (Next.js's `**/*.ts`, `tsc --init`'s absent `include`) and prints the one-line fix — `"exclude": ["node_modules", "aws-blocks"]`. It does not edit the file: `include`/`exclude` decide program roots, so a covered backend is checked under frontend settings whatever the import resolved to, and skipping the fix fails loudly on the next typecheck. The app `AGENTS.md` carries the same fix.
- `@aws-blocks/core/scripts` exports `generateBackendTypes`. Generation runs the app's own `tsc`, so it works with TypeScript 5.x and 7, and is killed after 2 minutes rather than hanging a build.

**Breaking for apps scaffolded before this change.** Generated types are now the only supported layout, so a backend workspace that still points `exports["."].types` at `./index.ts`, or that has no `aws-blocks/tsconfig.types.json`, fails with the migration steps instead of carrying on. It is a hard error on purpose: carrying on means the frontend keeps typechecking the backend source — the bug this fixes — without saying so.

To migrate an existing app:

1. Copy `aws-blocks/tsconfig.types.json` from a newly created app.
2. Set `exports["."].types` in `aws-blocks/package.json` to `./.types/index.d.ts`.
3. Add `aws-blocks/.types/` to `.gitignore`.
4. Run `npx blocks-generate-client`.
