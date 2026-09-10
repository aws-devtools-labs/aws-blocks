---
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/blocks": patch
---

fix(bb-dashboard): depend on `@aws-blocks/bb-lambda-compute@^0.4.0`

`bb-dashboard` declared its `@aws-blocks/bb-lambda-compute` devDependency as
`^0.3.0`, which excludes the current workspace version (`0.4.0`). npm therefore
installed the published `0.3.0` tarball into `bb-dashboard` instead of linking
the local workspace, and two failures followed: the root `package-lock.json`
fell out of sync (breaking `npm ci` repo-wide), and `bb-dashboard`'s CDK test
crashed with `ERR_PACKAGE_PATH_NOT_EXPORTED` importing
`@aws-blocks/bb-lambda-compute/cdk` — a subpath the old `0.3.0` did not export.

Aligning the range to `^0.4.0` links the local workspace (which exports
`./cdk`), fixing both. Dev-dependency-only; no runtime or API change.
