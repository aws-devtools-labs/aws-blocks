---
"@aws-blocks/create-blocks-app": patch
---

Pin the `aws-cdk` CLI as a template `devDependency` so scaffolded apps no longer auto-install the CLI via `npx` on first deploy (avoiding first-run install latency and an uncontrolled floating CLI version). The `aws-cdk` CLI is versioned independently of `aws-cdk-lib`, so it is pinned to its own release line (`^2.1141.0`) rather than to the library's version.
