---
"@aws-blocks/hosting": patch
---

A SvelteKit app whose server code imports a package from its `dependencies` (for example `withAuth` from `@aws-blocks/blocks/server`) now runs after a deploy. Until now the server function shipped `build/` without `node_modules`, so every server-rendered page failed with `ERR_MODULE_NOT_FOUND` while the deploy reported success. The build now bundles the server's dependencies through a build-only Vite plugin (`ssr.noExternal: true`), and synth fails with `SvelteKitUnbundledDependencyError` when the server still imports a package that `build/` can't resolve.
