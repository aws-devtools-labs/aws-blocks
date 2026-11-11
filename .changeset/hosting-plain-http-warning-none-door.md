---
'@aws-blocks/hosting': patch
'@aws-blocks/blocks': patch
---

`frontDoor: 'none'` now always warns at synth (`@aws-blocks/hosting:PlainHttpFrontDoor`), including for a static site with no backend API. The S3 website endpoint takes no certificate, so the pages and scripts travel unencrypted and can be altered in transit. The warning explains this and points to the CloudFront door for HTTPS. It stays a warning: synth still succeeds.
