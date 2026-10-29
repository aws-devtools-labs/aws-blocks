---
"@aws-blocks/create-blocks-app": patch
---

Git-ignore `.bb-data/` in the `nextjs` template and when adding AWS Blocks to an existing project or an Amplify Gen 2 project. That directory holds local dev state, including every `AppSetting` and secret value in `.bb-data/settings.json`, so `git add .` could commit local secret values.
