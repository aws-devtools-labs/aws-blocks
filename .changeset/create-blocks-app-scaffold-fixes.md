---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): fail on a failed install, and fix scaffolds that did not work

- `create-blocks-app` exits 1 when a step such as `npm install` fails, instead of printing the error and exiting 0, so `npx @aws-blocks/create-blocks-app app && cd app` stops at the failed scaffold.
- The `nextjs` template's `.gitignore` ignores `.open-next/` (the deploy's build output) and `*.tsbuildinfo` (written by `next build`).
- Adding AWS Blocks to an existing project adds `zod` to its dependencies, at the template's version, when the copied `aws-blocks/` backend imports it. Before, `zod` resolved only when another package happened to hoist it.
