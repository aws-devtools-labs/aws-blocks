---
"@aws-cdk-blocks/create-blocks-app": patch
---

The `nextjs` template's `tsconfig.json` now includes the `ESNext` library, so a backend that lists items with `Array.fromAsync(...)`, as the Building Block docs do, type-checks in `next build`. It stopped at `ES2022`, and `next build` failed with `TS2550: Property 'fromAsync' does not exist on type 'ArrayConstructor'`.
