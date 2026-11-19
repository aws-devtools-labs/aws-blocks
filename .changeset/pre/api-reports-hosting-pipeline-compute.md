---
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/pipeline': patch
'@aws-cdk-blocks/bb-compute': patch
---

Add API Extractor reports (`API.md`) for `@aws-cdk-blocks/hosting`, `@aws-cdk-blocks/pipeline` and `@aws-cdk-blocks/bb-compute`, so changes to their public surface show up in review like the other packages' (`npm run update:api`, checked by `npm run check:api`). The block docs folder of `aws-cdk-blocks` ships them next to each package's README.
