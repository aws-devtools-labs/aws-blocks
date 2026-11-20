---
'@aws-cdk-blocks/create-blocks-app': patch
---

Fix the todo form in the `default`, `react`, `auth` and `demo` templates erasing text typed while the previous todo was still being saved. The form now clears when the request starts, and puts the title back if the request fails.
