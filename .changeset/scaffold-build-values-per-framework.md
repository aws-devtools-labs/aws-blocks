---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/core": patch
---

Adding AWS Blocks to an existing Next.js, Nuxt (or another Nitro framework), Astro or SvelteKit project now writes a `Hosting` that names the framework and leaves the build to its adapter, instead of Vite's `buildCommand: 'npm run build'` and `buildOutputDir: 'dist'`. Before, the first deploy of such a project failed: an Astro app with server-rendered pages and no server adapter failed in its own `npm run build` (`NoAdapterInstalled`) before the adapter could add `@astrojs/node`, and a Nuxt, SvelteKit or Next.js build never writes `dist/`. Other projects keep the Vite settings.

`Hosting` with `framework` `nextjs`, `nitro` (or its alias `nuxt`), `astro` or `sveltekit`, no `buildCommand` and no `customAdapter` now runs the framework adapter, which builds the app, when no build output exists yet. Before, the synth failed with `Build output directory not found` before the adapter ran. With `BLOCKS_SKIP_FRONTEND_BUILD=1` the output still has to exist. The default build output dir of a Nitro (or `nuxt`) app is now `.output`, where Nitro writes it, instead of `dist`. If the template's `Hosting` doesn't have the build settings `create-blocks-app` expects, it now prints the edit to make by hand instead of silently keeping the Vite settings.
