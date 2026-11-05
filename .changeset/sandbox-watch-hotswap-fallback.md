---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`npm run sandbox` now deploys infrastructure changes made while it watches. Its `cdk watch` ran with CDK's default `--hotswap`, which applies code-only changes but silently ignores any change it can't hotswap. Adding a Building Block that needs new infrastructure, such as a `Database` or `Realtime`, therefore updated the Lambda code that uses it and never created it, with no message. The watch now passes `--hotswap-fallback`: a code-only change still hotswaps in seconds, and any other change runs a full deploy of the stack.
