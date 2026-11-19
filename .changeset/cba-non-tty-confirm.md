---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing project (or an Amplify Gen 2 project) without a terminal and without `--yes` now exits with status 1 and says to pass `--yes`. It used to print `Proceed? (y/N)`, read the end of input as "no", write nothing and exit 0, so a script or CI job carried on as if the backend had been added. Answering "no" at the prompt still exits 0.
