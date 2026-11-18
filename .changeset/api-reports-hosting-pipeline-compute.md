---
'@aws-blocks/hosting': patch
'@aws-blocks/pipeline': patch
'@aws-blocks/bb-compute': patch
---

Add API Extractor reports (`API.md`) for `@aws-blocks/hosting`, `@aws-blocks/pipeline` and `@aws-blocks/bb-compute`, so changes to their public surface show up in review like the other packages' (`npm run update:api`, checked by `npm run check:api`). The block docs folder of `@aws-blocks/blocks` ships them next to each package's README.
