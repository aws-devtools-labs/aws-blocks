---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`npm run deploy`, `sandbox` and the other app tasks work in a project that has no `typescript` package, such as a Nuxt or Astro app that AWS Blocks was added to. `@aws-blocks/core` declares `typescript` (`>=5.0.0`) as a peer dependency, so npm installs it with the app, and loads the TypeScript compiler only to read the API's types when it writes the OpenRPC spec. Without it the spec describes every method as `unknown` and says to install `typescript`. A package that core imports and can't find is no longer reported as a version mismatch between `@aws-blocks/blocks` and `@aws-blocks/core`.
