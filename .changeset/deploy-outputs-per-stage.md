---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(core): give each deploy stage its own CDK outputs file

`npm run deploy` and `npm run sandbox` both wrote `--outputs-file .blocks-sandbox/outputs.json`, and the CDK CLI replaces that file with the stacks of the one invocation that wrote it rather than merging into it. A production deploy therefore left only its own stack in the document the sandbox reads, and a deploy that failed on its first stack wrote an empty document, blanking the record of a stack that was still standing.

Each stage now writes its own document:

- the sandbox keeps `.blocks-sandbox/outputs.json`
- production writes `.blocks-sandbox/outputs.production.json`

Both stay in `.blocks-sandbox/`, which is already ignored, so neither can be committed by a missing ignore entry.

`cdk-blocks destroy` and `cdk-blocks sandbox destroy` now forget the deleted stack in the document of the stage being destroyed, instead of always in `outputs.json`.

**If you read `.blocks-sandbox/outputs.json` for production** (a script, a CI step, or a launcher), read `.blocks-sandbox/outputs.production.json` instead. `OUTPUTS_FILE` from `@aws-blocks/core/scripts` carries both paths. Nothing needs migrating: the next deploy of each stage writes its own document, and a pre-split `outputs.json` holding production's stack is no longer used to name a stack.
