---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing project now prints the warning `Hosting` has for the project's installed `next`, when the backend it adds defines a `Hosting`. Before, the first sign of a `next` that the OpenNext build doesn't support was that warning in the hosting build, at deploy time. The CLI asks the project's own `@aws-blocks/hosting` after the install (`checkNextjsCompatibility` from `@aws-blocks/hosting/nextjs-compatibility`) and prints what it answers: whether `Hosting` builds the app with Next.js, which versions are supported and the wording are all that Hosting release's. The CLI adds only that your `next` was not changed.

It prints nothing when that Hosting has no warning, is not installed (for example with `--skip-install`), or predates that export. The hosting build still checks then.
