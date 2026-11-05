---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

`Hosting` no longer rebuilds the frontend on a synth that doesn't need it:

- **Destroy:** `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output already on disk instead of running `buildCommand` and the framework build (OpenNext, Nitro, Astro, SvelteKit). On a Next.js app this removes a multi-minute build from every destroy. When there is no build output, the destroy builds as before.
- **Opt-in deploy reuse:** `BLOCKS_SKIP_FRONTEND_BUILD=1` makes a deploy use the existing build output without building. A missing output directory fails the synth with a message naming the variable. The build bakes in `BLOCKS_API_URL`, so a deploy never reuses a build on its own.

The framework adapters read the decision from the build profile (`reuseBuild: 'if-present' | 'required'`); an explicit `skipBuild` option still wins.
