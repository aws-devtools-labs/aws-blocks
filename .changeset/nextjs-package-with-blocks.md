---
"@aws-blocks/nextjs": patch
---

New package: `@aws-blocks/nextjs`, the Next.js integration for AWS Blocks.

`withBlocks()` wraps your `next.config` so blocks work in server code. Server Components, Server Actions, and route handlers use blocks **directly, in process** — no RPC hop and no wrapper method per query shape.

```ts
// next.config.ts
import { withBlocks } from '@aws-blocks/nextjs';

export default withBlocks({ output: 'standalone' });
```

Today it keeps blocks that load WASM or native assets out of the server bundle: bundlers rewrite the `new URL(..., import.meta.url)` expression those packages use to find their assets, which breaks `bb-data`'s PGlite engine identically under Turbopack and webpack. Your own `serverExternalPackages` entries are merged, never replaced.

A module that constructs blocks must start with `import 'server-only'` so a Client Component importing it fails the build instead of shipping an AWS SDK to the browser. See the README for the full programming model.
