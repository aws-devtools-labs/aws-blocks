---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): fail on a failed install, and fix scaffolds that did not work

- `create-blocks-app` exits 1 when a step such as `npm install` fails, instead of printing the error and exiting 0, so `npx @aws-blocks/create-blocks-app app && cd app` stops at the failed scaffold.
