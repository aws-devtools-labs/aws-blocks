---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

Hosting's framework builds no longer print an `ENOTDIR` error and its stack trace when they look for a package the project doesn't install, for example the Next.js build of an app without `@opennextjs/aws`. The lookup still finds the app's own copy of a package before one hoisted to a workspace root.
