---
"@aws-blocks/create-blocks-app": patch
---

Add the missing `vendorize` script to the `auth-cognito` template. Every other deployable template shipped `"vendorize": "blocks-vendorize"`, but auth-cognito omitted it, so `npm run vendorize` (used to inline a Building Block's source for customization) didn't work in scaffolded auth-cognito apps. Also adds a regression test asserting every deployable template carries the standard `vendorize` script.
