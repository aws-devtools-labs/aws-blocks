---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): set the storage-encryption flag in the api-only and sql templates

The `api-only` and `sql` template `cdk.json` files did not set the
`@aws-blocks/bb-data:encryptStorageByDefault` context flag, so new projects
scaffolded from them started with Database storage encryption OFF — unlike every
other template. Add the `context` flag (boolean `true`) to both, matching the
other templates and the encrypt-by-default contract.
