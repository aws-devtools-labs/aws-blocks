---
'@aws-cdk-blocks/bb-database': patch
---

The Aurora DSQL cluster a `Database` or `DatabaseCluster` creates now carries the tags applied with `Tags.of()`, including the `app=<id>` tag that `defaults.appIdentity` stamps on every resource, in the synthesized template. The cluster keeps its logical id and properties, so an existing cluster is updated in place, not replaced.
