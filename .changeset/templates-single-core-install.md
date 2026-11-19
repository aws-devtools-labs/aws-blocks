---
"@aws-cdk-blocks/create-blocks-app": patch
---

fix(create-blocks-app): install one copy of `@aws-cdk-blocks/core` in a new app

Every template declared `@types/node` `^20.19.43`. `@aws-cdk-blocks/core` has an optional peer chain (`unctx` → `unplugin` → `vitest`) that ends in `@types/node` `^22.0.0 || >=24.0.0`, so npm could not place `core` at the top of a new app and installed one copy under each block instead (25 in a full app). `core` keeps module-level registries, so the copies did not see each other: `getSdkIdentifiers()` returned `{}`, an error from a block failed `instanceof ApiError` on the server, and `@aws-cdk-blocks/core` could not be imported from app code.

The templates, and the backend and Amplify setups, now declare `@types/node` `^22.12.0`, which matches the templates' Node `>=22` engine. An existing app gets one copy of `core` after the same change to its `package.json` and an `npm install`.
