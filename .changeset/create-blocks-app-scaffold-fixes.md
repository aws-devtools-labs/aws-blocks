---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): fail on a failed install, and fix scaffolds that did not work

- `create-blocks-app` exits 1 when a step such as `npm install` fails, instead of printing the error and exiting 0, so `npx @aws-blocks/create-blocks-app app && cd app` stops at the failed scaffold.
- The `nextjs` template's `.gitignore` ignores `.open-next/` (the deploy's build output) and `*.tsbuildinfo` (written by `next build`).
- Adding AWS Blocks to an existing project adds `zod` to its dependencies, at the template's version, when the copied `aws-blocks/` backend imports it. Before, `zod` resolved only when another package happened to hoist it.
- Scaffolding into a workspace of an npm workspaces monorepo stops before it writes anything, unless the monorepo root also lists the app's `aws-blocks/` folder, and prints the `"workspaces"` entry to add; once the root lists it, `npm install` runs at the root, where npm links the app's `aws-blocks` package. npm installs a workspace's dependencies at the root and ignores the app's nested `"workspaces": ["aws-blocks"]`, so before this the scaffold reported success with an app that could not import `aws-blocks`.
- `npm run test:e2e` can run again and again against one running dev server, as `AGENTS.md` suggests: it exits when the tests finish (`--test-force-exit`) instead of hanging on the realtime client's open socket, and the `default` and `react` tests sign up a new user each run instead of a fixed `testuser@example.com`, which the persisted local auth store already had on the second run.
