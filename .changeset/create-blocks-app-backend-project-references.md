---
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/blocks": patch
---

feat(create-blocks-app): typecheck the backend with Node types and the browser code without them

The frontend imports the backend (`import { api } from 'aws-blocks'`), so its `tsconfig` typechecked the backend source with the frontend's settings. The templates passed because their one `tsconfig.json` made Node types global, which also let browser code use `process` or `Buffer` without an error, and a frontend `tsconfig` with `"types": ["vite/client"]`, as create-vite's has, failed with `TS2591: Cannot find name 'process'` in `aws-blocks/`.

- The Vite templates (`default`, `bare`, `react`, `auth-cognito`, `demo`) now check the browser and the backend as separate TypeScript projects, the way create-vite's `react-ts` template does: `tsconfig.app.json` checks `src/` without Node types and reads the backend through a project reference to `aws-blocks/tsconfig.json`, which checks every backend file with Node types. `npm run typecheck` is `tsc -b --force`, and `npm run build` is `tsc -b --force && vite build`. A Node global in `src/` is now a type error.
- `nextjs` and the backend-only templates keep one `tsconfig.json` with Node types: `next build` ignores project references, and backend-only apps run all their code on Node.
- Adding AWS Blocks to an existing project writes `aws-blocks/tsconfig.json` (except in a Next.js project) and prints how to reference it. It never edits the project's `tsconfig`.
- Apps scaffolded before this change keep working as they are. To move one to the new layout, see [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend). `TROUBLESHOOTING.md` in `@aws-blocks/blocks` lists the TypeScript errors of the layout and their fixes.
