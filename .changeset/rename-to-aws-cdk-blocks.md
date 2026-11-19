---
'aws-cdk-blocks': minor
'@aws-cdk-blocks/admin-ui': minor
'@aws-cdk-blocks/auth-common': minor
'@aws-cdk-blocks/bb-agent': minor
'@aws-cdk-blocks/bb-app-setting': minor
'@aws-cdk-blocks/bb-async-job': minor
'@aws-cdk-blocks/bb-auth': minor
'@aws-cdk-blocks/bb-compute': minor
'@aws-cdk-blocks/bb-container-compute': minor
'@aws-cdk-blocks/bb-cron-job': minor
'@aws-cdk-blocks/bb-dashboard': minor
'@aws-cdk-blocks/bb-database': minor
'@aws-cdk-blocks/bb-email-client': minor
'@aws-cdk-blocks/bb-file-bucket': minor
'@aws-cdk-blocks/bb-knowledge-base': minor
'@aws-cdk-blocks/bb-kv-store': minor
'@aws-cdk-blocks/bb-lambda-compute': minor
'@aws-cdk-blocks/bb-logger': minor
'@aws-cdk-blocks/bb-metrics': minor
'@aws-cdk-blocks/bb-realtime': minor
'@aws-cdk-blocks/bb-secret': minor
'@aws-cdk-blocks/bb-tracer': minor
'@aws-cdk-blocks/core': minor
'@aws-cdk-blocks/create-block': minor
'@aws-cdk-blocks/create-blocks-app': minor
'@aws-cdk-blocks/hosting': minor
'@aws-cdk-blocks/pipeline': minor
---

Rename every published package from the `@aws-blocks` scope to `@aws-cdk-blocks`. The umbrella package is now unscoped: `@aws-blocks/blocks` becomes `aws-cdk-blocks`.

No export or option moved. To upgrade, replace the dependency names in `package.json` and the specifiers in every import:

```diff
 {
   "dependencies": {
-    "@aws-blocks/blocks": "^0.9.0",
-    "@aws-blocks/core": "^0.9.0"
+    "aws-cdk-blocks": "^0.10.0",
+    "@aws-cdk-blocks/core": "^0.10.0"
   }
 }
```

```diff
-import { KVStore } from '@aws-blocks/blocks';
+import { KVStore } from 'aws-cdk-blocks';

-import { ApiNamespace } from '@aws-blocks/core';
+import { ApiNamespace } from '@aws-cdk-blocks/core';
```

Warning IDs reported at synth carry the package name, so they now start with `@aws-cdk-blocks/` instead of `@aws-blocks/`: update any `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the new prefix. An acknowledgement left on an old ID silently stops matching, the warning comes back, and `cdk synth --strict` fails on it.

The `cdk-blocks` CLI binary, the `aws-blocks` keyword used to discover third-party blocks, and the `aws-blocks` manifest key that carries the `native` and `vendorize` declarations are all unchanged, so a published third-party block is still discovered and still loads its manifest without a republish. A block that depends on `@aws-blocks/core` brings its own copy of core alongside the app's `@aws-cdk-blocks/core`, which is two module instances; block authors should move the dependency to `@aws-cdk-blocks/core`.

The old `@aws-blocks/*` packages stop receiving releases.
