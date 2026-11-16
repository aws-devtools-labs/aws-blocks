---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing project now shows, when the backend it adds defines a `Hosting`, the warning that the project's own `@aws-blocks/hosting` has for the installed `next`, so you see it while setting up instead of at the first deploy. The CLI asks that Hosting after the install (`checkNextjsCompatibility` from `@aws-blocks/hosting/nextjs-compatibility`) and prints its answer: whether there is a warning and what it says are that Hosting release's. The CLI adds only where the warning is from and that your `next` was not changed.

It prints nothing when that Hosting has no warning, is not installed (for example with `--skip-install`), predates that export, or fails.
