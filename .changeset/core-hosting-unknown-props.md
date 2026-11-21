---
"@aws-cdk-blocks/core": patch
---

`Hosting` warns at synth (`@aws-cdk-blocks/core:UnknownHostingProp`) for each top-level prop it doesn't read, such as a misspelled setting or a `HostingConstruct` prop like `cdn`, instead of dropping it silently. TypeScript already rejects such a key in an object literal; the warning covers config written in JavaScript, read from JSON or spread from another object. It is a warning, so an app that passes such a key still synthesizes.
