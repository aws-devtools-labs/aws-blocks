---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

fix: `Database` and `DistributedDatabase` with `migrationsPath` synthesize in a project path that contains a space

The migration Lambda's bundling step copied the migrations with an unquoted `cp -r <migrationsPath> <output>`, which runs in a shell. In a path such as `~/My Projects/app`, the copy failed and so did the synth (`FailedToBundleAsset`), for the `sql` template among others. Both paths are now quoted.
