---
'@aws-blocks/hosting': patch
---

The hosting adapters no longer print an `Error: ENOTDIR: not a directory, open '<app>/package.json/package.json'` stack trace when they check for a package the app doesn't have, such as a Nuxt app without `@nuxt/image`. The check already reported the package as not installed; only the misleading error output is gone.
