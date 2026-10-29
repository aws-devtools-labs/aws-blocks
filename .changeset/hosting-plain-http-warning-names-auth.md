---
'@aws-blocks/hosting': patch
---

The `PlainHttpFrontDoor` synth warning for a plain-HTTP ALB door now refers to `Auth`, which drops `Secure` from its session cookie behind such a door so that sign-in still works. It no longer names the removed `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks.
