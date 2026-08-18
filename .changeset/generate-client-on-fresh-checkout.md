---
"@aws-blocks/create-blocks-app": patch
---

Generate the local `aws-blocks` package's client entry point on fresh checkouts. The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a committed scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis). A `prebuild` hook in the six affected templates now regenerates the file via `writeClientCode` before every build. Also gitignores `.hosting/`, the Vite output written during synthesis.
