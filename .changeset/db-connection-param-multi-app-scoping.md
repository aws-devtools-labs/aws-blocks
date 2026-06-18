---
"@aws-blocks/core": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-data": patch
---

Fix: store the external-database connection string in a stack-scoped SSM parameter (`/<stackName>-...-db-url`) instead of a stage-only name (`/blocks/{stage}/db-connection-string`). The stage-only name had no app identity, so two Blocks apps deployed to the same AWS account/region/stage silently overwrote each other's connection string. The parameter is now self-named via the framework default (`/${fullId}`), exposed as a CloudFormation output, and seeded after a successful deploy using that exact name — making the written, stamped, and read names identical by construction.
