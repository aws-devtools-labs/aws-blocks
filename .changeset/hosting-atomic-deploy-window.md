---
"@aws-blocks/hosting": patch
---

fix(hosting): make redeploys atomic by uploading assets before the CloudFront build-id cutover, eliminating the 403 window for new visitors during deployment
