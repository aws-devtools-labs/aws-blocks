---
'@aws-blocks/core': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': minor
'@aws-blocks/admin-ui': minor
'@aws-blocks/bb-auth': minor
'@aws-blocks/bb-database': minor
'@aws-blocks/create-block': minor
'@aws-blocks/hosting': minor
'@aws-blocks/auth-common': patch
'@aws-blocks/bb-agent': patch
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-logger': patch
'@aws-blocks/bb-realtime': patch
---

refactor: rename the scaffolded backend folder to `cdk-blocks`

`create-blocks-app` now scaffolds the backend into `cdk-blocks/`, the folder's own package is named `cdk-blocks`, the parent lists it under `"workspaces"`, and the frontend imports it as `cdk-blocks`.

`@aws-blocks/bb-database` moves its default migrations root with the folder: `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`, and `db pull` writes `cdk-blocks/database.types.ts` by default. An app that keeps an `aws-blocks/migrations` directory finds no migrations after upgrading, so rename the directory or set an explicit migrations path.

**Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.** An existing app renames the directory, the `"workspaces"` entry that names it, the `"name"` in its `cdk-blocks/package.json`, and every `from 'aws-blocks'` import. There is no dual-name support and no compatibility shim.

The reserved URL namespace (`/aws-blocks/api`, `/aws-blocks/auth/*`, `/aws-blocks/dashboard`) keeps its path, so deployed API Gateway routes and OAuth callback URLs already registered with an identity provider keep working.
