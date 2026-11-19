---
'@aws-cdk-blocks/core': patch
---

At the `normal` log level, which `npm run deploy`, `npm run sandbox` and the other generated tasks use by default, a deploy, sandbox or destroy now prints every synth warning (a CDK warning annotation, such as `@aws-cdk-blocks/hosting:PlainHttpFrontDoor` for a front door without a certificate) with its source locations, construct path and acknowledgement line, once each. That includes a warning that a `npm run sandbox` watch deploy raises after the initial deploy. Before, those warnings showed only with `--verbose` or when the deploy failed. The README's `BLOCKS_LOG_LEVEL` section now says that the generated tasks run at `normal` unless you choose another level.
