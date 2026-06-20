---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): respect `--template` when adding Blocks to an existing project

Adding Blocks to an existing project always copied the `aws-blocks/` workspace from
the `default` (Vite) template, ignoring `--template`. Running
`npm create @aws-blocks/blocks-app . -- --template nextjs` in a Next.js project
therefore generated a `scripts/server.ts` whose `frontendCommand` was `npx vite ...`
instead of `npx next dev ...`, so `npm run dev:server` tried to launch Vite in a
project without it.

The requested template now drives the copied `aws-blocks/` workspace, `cdk.json`, and
devDeps, falling back to `default` when the template has no `aws-blocks/` workspace.
