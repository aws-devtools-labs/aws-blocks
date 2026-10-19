---
"@aws-blocks/bb-logger": patch
---

fix: `Logger` methods work during `cdk synth`

A top-level `log.info(...)` or `log.child(...)` in a backend module also runs during `cdk synth`, where it crashed with
`log.info is not a function`. Under `cdk` the logger now writes the same structured JSON lines as at runtime, honoring
`level` and `defaultContext`.
