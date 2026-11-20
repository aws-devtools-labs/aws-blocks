---
"@aws-cdk-blocks/create-block": patch
---

New Building Blocks scaffolded inside the AWS Blocks repo now get a JSDoc pointer
to their docs bundled in `aws-cdk-blocks` (`docs/<package>/README.md`),
matching the other re-exports, instead of a `node_modules` package directory.
