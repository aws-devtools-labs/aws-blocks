---
'@aws-blocks/hosting': patch
'@aws-blocks/blocks': patch
---

`frontDoor: 'none'` now always warns at synth (`@aws-blocks/hosting:PlainHttpFrontDoor`), including for a static site with no backend API. The S3 website endpoint takes no certificate, so the pages and scripts travel unencrypted and can be altered in transit. The warning explains this, points to the CloudFront door for HTTPS, and names how to acknowledge it when `'none'` is intended (`Annotations.of(stack).acknowledgeWarning('@aws-blocks/hosting:PlainHttpFrontDoor')`). It stays a warning: synth still succeeds.
