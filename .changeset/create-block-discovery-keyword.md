---
"@aws-blocks/create-block": patch
---

chore(create-block): add the `aws-blocks` discovery keyword

`@aws-blocks/create-block` was missing the `aws-blocks` keyword that every
other published package carries, so it never surfaced in
`npm search keywords:aws-blocks` (the documented discovery path from #491).
Adds the keyword alongside functional keywords describing the scaffolder.
