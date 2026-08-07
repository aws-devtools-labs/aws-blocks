---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix(telemetry): detect Render as CI

Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
omitted Render, which sets `RENDER=true` on every build and service. Render
runs were therefore reported as real user sessions instead of `ci:true`,
inflating user metrics. `RENDER` is now included in both `isCI()`
implementations (`@aws-blocks/core` and `@aws-blocks/create-blocks-app`). The
umbrella `@aws-blocks/blocks` gets a patch bump because it re-exports
`@aws-blocks/core`.
