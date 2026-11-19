---
"aws-cdk-blocks": minor
"@aws-cdk-blocks/create-blocks-app": minor
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/bb-database": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/admin-ui": patch
"@aws-cdk-blocks/hosting": patch
---

Run AWS Blocks tasks with your app's package manager. New apps define tasks in `package.json` without generating launcher files or installing the `cdk-blocks` executable. Look up documentation with `npm run docs KVStore`, read the API signatures with `npm run docs:api KVStore`, or search with `npm run docs:search "partition key"`.

Structured task results print text in a terminal and JSON on a pipe or redirect. Use `npm run -s docs KVStore` for clean JSON without npm's banner, or `npm run -s docs -- KVStore --output text` to pipe Markdown. Scripts that previously invoked `cdk-blocks` must switch to package tasks; scripts calling the programmatic `aws-cdk-blocks/scripts` entry remain supported.

If your app's scripts call `cdk-blocks`, upgrade `aws-cdk-blocks` first. From the app directory, preview the migration without relying on the removed executable:

```sh
node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run
```

Review the plan, then run the same command without `--dry-run` from a clean Git working tree. The migration rewrites recognized generated scripts and reports custom wrappers that need manual changes.
