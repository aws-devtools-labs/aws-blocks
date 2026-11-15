---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing project now makes sure `node_modules` is git-ignored. The CLI adds dependencies, so a project with no `.gitignore`, or one that did not ignore `node_modules`, had the directory staged by the next `git add -A` after `npm install`. A `.gitignore` that already covers it (`node_modules`, `node_modules/`, `/node_modules`, `**/node_modules`) is left as it is.
