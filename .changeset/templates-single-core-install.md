---
"@aws-cdk-blocks/create-blocks-app": patch
---

fix(create-blocks-app): a new app now installs one copy of `@aws-cdk-blocks/core`.

The templates declared `@types/node` `^20.19.43`, which made npm install a separate copy of `core` under each block. The copies did not share state, so `getSdkIdentifiers()` returned `{}` and app code could not import `@aws-cdk-blocks/core`. The templates now declare `@types/node` `^22.12.0`.

To fix an existing app, make the same change in its `package.json` and run `npm install`.
