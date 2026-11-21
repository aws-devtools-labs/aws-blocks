---
'@aws-cdk-blocks/core': patch
'aws-cdk-blocks': patch
'@aws-cdk-blocks/create-blocks-app': patch
---

`npm run deploy`, `sandbox` and the other app tasks work in a project that has no `typescript` package, such as a Nuxt or Astro app that AWS CDK Blocks was added to. `@aws-cdk-blocks/core` declares `typescript` (`>=5.0.0 <7`) as a peer dependency, so npm installs it with the app, and loads the TypeScript compiler only to read the API's types when it writes the OpenRPC spec. Without it the spec describes every method as `unknown` and says to install `typescript`; methods tagged `@blocksSkipCodegen` stay in it until then. An app pinned to TypeScript 4.x needs TypeScript 5 or later. Adding AWS CDK Blocks to an existing project also adds `typescript` to its devDependencies when it has none, for package managers that skip peers. A package that core imports and can't find is no longer reported as a version mismatch between `aws-cdk-blocks` and `@aws-cdk-blocks/core`.
