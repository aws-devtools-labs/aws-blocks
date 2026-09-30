---
"@aws-blocks/create-block": patch
---

Validate the derived npm scope and run the workspace build/test via `execFileSync` (argument array) instead of a shell string in the block scaffolder.

The scope resolved from the customer workspace `package.json` `name` now passes the same allowlist as the `--scope` flag before it flows into the package name, and `verify()` invokes `npm run build`/`npm test` through an argv array rather than an interpolated shell command.
