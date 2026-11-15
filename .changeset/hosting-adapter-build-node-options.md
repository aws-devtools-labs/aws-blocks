---
"@aws-blocks/hosting": patch
---

The Astro, Nitro (Nuxt, SolidStart, Analog, TanStack Start) and SvelteKit adapters run the app's build without the `cdk` export condition. A deploy or destroy synthesizes with `NODE_OPTIONS=--conditions=cdk`, and the app's build inherited it, so a build or `prebuild` script that loads `@aws-blocks/*` (such as `cdk-blocks generate client`) failed with `Scope at '...' should be created in the scope of a Stack`. Only the `cdk` condition is removed: other `NODE_OPTIONS` entries, such as `--max-old-space-size`, still reach the build.
