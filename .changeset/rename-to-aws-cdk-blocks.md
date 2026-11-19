---
'aws-cdk-blocks': major
'@aws-cdk-blocks/admin-ui': major
'@aws-cdk-blocks/auth-common': major
'@aws-cdk-blocks/bb-agent': major
'@aws-cdk-blocks/bb-app-setting': major
'@aws-cdk-blocks/bb-async-job': major
'@aws-cdk-blocks/bb-auth': major
'@aws-cdk-blocks/bb-compute': major
'@aws-cdk-blocks/bb-container-compute': major
'@aws-cdk-blocks/bb-cron-job': major
'@aws-cdk-blocks/bb-dashboard': major
'@aws-cdk-blocks/bb-database': major
'@aws-cdk-blocks/bb-email-client': major
'@aws-cdk-blocks/bb-file-bucket': major
'@aws-cdk-blocks/bb-knowledge-base': major
'@aws-cdk-blocks/bb-kv-store': major
'@aws-cdk-blocks/bb-lambda-compute': major
'@aws-cdk-blocks/bb-logger': major
'@aws-cdk-blocks/bb-metrics': major
'@aws-cdk-blocks/bb-realtime': major
'@aws-cdk-blocks/bb-secret': major
'@aws-cdk-blocks/bb-tracer': major
'@aws-cdk-blocks/core': major
'@aws-cdk-blocks/create-block': major
'@aws-cdk-blocks/create-blocks-app': major
'@aws-cdk-blocks/hosting': major
'@aws-cdk-blocks/pipeline': major
---

Rename every published package from the `@aws-blocks` scope to `@aws-cdk-blocks`. The umbrella package is now unscoped: `@aws-blocks/blocks` becomes `aws-cdk-blocks`.

No export or option moved. To upgrade, replace the dependency names in `package.json` and the specifiers in every import:

```diff
 {
   "dependencies": {
-    "@aws-blocks/blocks": "<your range>",
-    "@aws-blocks/core": "<your range>"
+    "aws-cdk-blocks": "<your range>",
+    "@aws-cdk-blocks/core": "<your range>"
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

The CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` keeps its name too. `LegacyDatabaseCluster` reads it out of your `cdk.json`, where apps scaffolded before the cutover already set it, and no package was ever published under a `@aws-cdk-blocks/bb-data` name. Renaming the key would leave `StorageEncrypted` unset on a cluster deployed with it on, which CloudFormation answers by replacing the cluster. Keep the key as it is.

The old `@aws-blocks/*` packages stop receiving releases.
