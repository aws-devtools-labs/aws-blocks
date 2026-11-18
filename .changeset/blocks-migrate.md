---
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": patch
---

Migration moves recognized generated script wrappers to package tasks and carries generated dev settings into `package.json#blocks.dev`. It keeps customized wrappers and wrappers still referenced by app or workspace automation, and does not overwrite concurrent `package.json` changes. Preview the plan with `--dry-run`; migration requires a clean tracked working tree unless forced. The structured result lists rewrites, removed and retained wrappers, and dev configuration.
