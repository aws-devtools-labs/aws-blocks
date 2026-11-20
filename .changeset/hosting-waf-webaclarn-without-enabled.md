---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

`waf: { webAclArn }` compiles without `enabled`. A web ACL of your own needed a meaningless `enabled` (ignored when `webAclArn` is set), and without it `frontDoor: { features: { waf: { webAclArn } } }` failed with an error naming the stacked door's settings. `HostingWafConfig` now takes either `enabled` or `webAclArn`; a door built with `defineFrontDoor` still receives `features.waf.enabled` as a boolean.
