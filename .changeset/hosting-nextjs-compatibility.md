---
"@aws-blocks/hosting": minor
---

New `@aws-blocks/hosting/nextjs-compatibility` subpath. `checkNextjsCompatibility(projectDir)` returns the check the Next.js adapter makes before its OpenNext build, as data, without loading the adapter, `aws-cdk-lib` or anything that builds: the installed `next` version, the `@opennextjs/aws` that would build it (the one the project installs, else the version Hosting falls back to) with its `next` peer range, where that OpenNext came from, and whether the version is inside the range. It returns `undefined` when the project has no installed `next`, or when its installed `@opennextjs/aws` declares no usable `next` peer range. The adapter now takes its warning from this function; when it warns and what it prints are unchanged.
