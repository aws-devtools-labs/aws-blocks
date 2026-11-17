---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

`Hosting` no longer rebuilds the frontend on a synth that doesn't need it:

- **Destroy:** `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output already on disk instead of running `buildCommand` and the framework build (OpenNext, Nitro, Astro, SvelteKit). On a Next.js app this removes a multi-minute build from every destroy. When there is no build output, the destroy builds as before; a Next.js destroy reuses the `.open-next/` output of an earlier deploy. `BLOCKS_SKIP_FRONTEND_BUILD=1` doesn't apply to a destroy.
- **Opt-in deploy reuse:** `BLOCKS_SKIP_FRONTEND_BUILD=1` makes a deploy use the existing build output without building. A missing build output (the output directory, or the output the framework adapter deploys, such as Next.js's `.open-next/`) fails the synth with the adapter's error (same code and resolution) plus a line naming the variable. The build bakes in `BLOCKS_API_URL`, so a deploy never reuses a build on its own.

The framework adapters read the decision from the build profile (`reuseBuild: 'if-present' | 'required'`); an explicit `skipBuild` option still wins.
