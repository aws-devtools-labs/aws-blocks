---
"@aws-blocks/create-blocks-app": patch
---

New apps created from the `bare` template now include `zod` in their dependencies, so the template's commented Zod examples no longer need a separate `npm install zod`. When you add AWS Blocks to an existing project with `--template bare`, the example comment still tells you to run `npm install zod`.
