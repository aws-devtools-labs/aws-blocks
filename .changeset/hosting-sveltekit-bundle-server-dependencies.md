---
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

A SvelteKit app whose server code imports a package from its `dependencies` (for example `withAuth` from `aws-cdk-blocks/server`) now runs after a deploy. Until now the server function shipped `build/` without `node_modules`, so every server-rendered page failed with `ERR_MODULE_NOT_FOUND` while the deploy reported success. The build now bundles the server's dependencies through a build-only Vite plugin (`ssr.noExternal: true`) that a Node.js preload adds without writing to your project, and synth fails with `SvelteKitUnbundledDependencyError` when the server still needs a module that `build/` can't provide. Optional imports that the code handles failing don't fail synth, and a destroy skips the check.
