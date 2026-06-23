---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): bump `aws-cdk-lib` to `^2.257.0` in the react template

The react template pinned `aws-cdk-lib` to `2.245.0`, while every block (e.g. `@aws-blocks/bb-realtime`) declares a peer dependency of `aws-cdk-lib@^2.257.0`. The unmet peer caused npm to nest `@aws-blocks/bb-realtime` under `@aws-blocks/blocks/node_modules` instead of hoisting it to the top level. Because the generated `aws-blocks/client.js` imports `@aws-blocks/bb-realtime/mock-middleware` directly from the workspace, Vite failed to resolve it (`Failed to resolve import "@aws-blocks/bb-realtime/mock-middleware"`) and `npm run dev` broke. Aligning the version with the other templates (`^2.257.0`) satisfies the peer dependency so the block hoists correctly.
