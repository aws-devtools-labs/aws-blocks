---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing Next.js project now warns when the project's `next` is outside the versions `Hosting` builds as a server-rendered app (`>=15.5.28 <16 || >=16.4.1`, the `next` peer range of the OpenNext version `Hosting` builds with, or the `next` peer range of the `@opennextjs/aws` the project has installed). The warning names the version it found, from `node_modules/next` or else the range in `package.json`, and changes nothing: upgrading `next` is left to you. Before, the first sign was the warning the hosting build prints at deploy time. The backend-only templates add no `Hosting` and print no warning, and a static export that `Hosting` serves with `framework: 'static'` has no minimum version.
