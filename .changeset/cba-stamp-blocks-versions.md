---
"@aws-blocks/create-blocks-app": patch
---

Scaffolded apps now pin every `@aws-blocks/*` dependency to a caret range on the release line this CLI version was tested with (for example `"@aws-blocks/blocks": "^0.9.0"`) instead of `"*"`. This covers fresh projects from every template, the `aws-blocks/` workspace added to an Amplify Gen 2 project, and adding AWS Blocks to an existing project. A clean reinstall now stays on the release line the app was created with and picks up later releases on that line; moving to a new (pre-1.0: breaking) release line is your choice. A range your existing project already lists in `dependencies` is kept.

`@aws-blocks/create-blocks-app` is now released with every `@aws-blocks/blocks` release and has the same version number, so this release skips ahead to blocks' version. The latest CLI therefore starts a new app on the latest `@aws-blocks/blocks` release.

The `aws-blocks/` workspace added to an Amplify Gen 2 project now imports `KVStore` from `@aws-blocks/blocks` and no longer lists `@aws-blocks/bb-kv-store` as a dependency of its own.

Apps scaffolded with an earlier version still declare `"*"`, so their next clean install can pull a breaking release. To pin yours, replace each `"*"` for an `@aws-blocks/*` package in `package.json` (and in `aws-blocks/package.json`, if present) with a caret range for the version you have installed, for example `"^0.9.0"` (`npm ls @aws-blocks/blocks` shows it), then run `npm install`.
