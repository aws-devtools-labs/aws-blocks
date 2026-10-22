---
'@aws-blocks/core': patch
---

`npm run sandbox:destroy` now removes every stack the sandbox deploy creates (`cdk destroy --all`, the same selection `npm run sandbox` deploys with). Before, a sandbox app with more than one stack, such as one with a separate stack for an `ec2.Vpc.fromLookup`, or with `Hosting` and a Lambda@Edge function (an edge-runtime route or Next.js middleware) deployed outside us-east-1, which adds an `edge-lambda-stack-*` stack, could not be torn down: CDK refused with "specify which stacks to use", and the command failed after its retries without deleting any stack. CDK deletes dependent stacks first. A Lambda@Edge function can only be deleted after CloudFront removes its replicas, which can take a few hours, so if the edge stack fails to delete, run `npm run sandbox:destroy` again later.
