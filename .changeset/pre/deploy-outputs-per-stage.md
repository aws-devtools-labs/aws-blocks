---
"@aws-cdk-blocks/core": minor
"aws-cdk-blocks": minor
---

fix(core): give each deploy stage its own CDK outputs file

`npm run deploy` and `npm run sandbox` both wrote `--outputs-file .cdk-blocks-sandbox/outputs.json`, and the CDK CLI replaces that file with the stacks of the one invocation that wrote it rather than merging into it. A production deploy therefore left only its own stack in the document the sandbox reads, and a deploy that failed on its first stack wrote an empty document, blanking the record of a stack that was still standing.

Each stage now writes its own document:

- the sandbox keeps `.cdk-blocks-sandbox/outputs.json`
- production writes `.cdk-blocks-sandbox/outputs.production.json`

Both stay in `.cdk-blocks-sandbox/`, which is already ignored, so neither can be committed by a missing ignore entry.

`npm run destroy` and `npm run sandbox:destroy` now forget the deleted stack in the document of the stage being destroyed, instead of always in `outputs.json`. A production destroy also clears its stack from a pre-split `outputs.json`, so an app that deployed production before upgrading is not left recording a stack that no longer exists.

**If you read `.cdk-blocks-sandbox/outputs.json` for production** (a script, a CI step, or a launcher), read `.cdk-blocks-sandbox/outputs.production.json` instead. `OUTPUTS_FILE` from `@aws-cdk-blocks/core/scripts` carries both paths. The next deploy of each stage writes its own document, and `npm run sandbox:console` derives the sandbox stack rather than naming one out of a pre-split `outputs.json`.

**If you call `openConsole({ outputsFile })` directly** (the Kotlin and Swift example apps, and any app scaffolded before AWS Blocks package tasks), it still opens the document's first stack. On an app that deployed production before upgrading, that is production's stack until one `npm run sandbox` refreshes `outputs.json`, so run it once or delete the stale file.
