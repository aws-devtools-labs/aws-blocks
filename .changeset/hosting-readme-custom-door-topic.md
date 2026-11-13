---
"@aws-blocks/hosting": patch
---

docs: move "Bring your own front door" into `CUSTOM-FRONT-DOOR.md`

The guide to writing your own front door with `defineFrontDoor` (the example door, `DoorInput` and the return value, the `cf` helpers, `assertDoorConformance`, and stacking CloudFront over your own ALB) moves unchanged from the README into `CUSTOM-FRONT-DOOR.md`, which now ships with the package. The README's "Bring your own front door" section links to it and keeps what AWS Blocks checks and enforces for such a door: the synth errors and warnings of the wiring check, that features such as `waf` are not checked, the 10 KB CloudFront Function limit, `serverResponse: 'buffered'`, and the 403 on request bodies through a Function URL with origin access control.
