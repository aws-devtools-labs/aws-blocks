---
'@aws-cdk-blocks/core': patch
---

At the `normal` log level, a Next.js deploy behind the CloudFront door no longer prints OpenNext's `ERROR Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible` line. The Next.js adapter configures that pair on purpose and patches the bundle after the build, so the line is expected on every healthy build. It still prints with `--verbose`, next to the adapter's line that explains it, and every other OpenNext error still prints at `normal`.
