---
"@aws-cdk-blocks/hosting": patch
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/create-blocks-app": patch
---

A SvelteKit 3 project (what `npx sv create` scaffolds) is now refused before any build runs. `Hosting` checks the installed `@sveltejs/kit` before it runs `buildCommand`, and `UnsupportedSvelteKitVersionError` names the SvelteKit 2 versions to pin (`@sveltejs/kit@^2`, `@sveltejs/adapter-node@^5`, `@sveltejs/vite-plugin-svelte@^5`, `vite@^6`). `create-blocks-app .` stops before it writes anything in a SvelteKit 3 project and prints the same versions. The Hosting README now states the supported range: SvelteKit 2 (`>=2.0.0 <3.0.0`). The new `assertFrameworkSupported(framework, projectDir)` from `@aws-cdk-blocks/hosting/adapters` runs these build-free checks.
