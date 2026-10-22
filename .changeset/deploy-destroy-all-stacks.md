---
'@aws-blocks/core': patch
---

`npm run deploy` and `npm run destroy` now act on every stack in the app (`cdk deploy --all`, `cdk destroy --all`), the same selection `npm run sandbox` already deploys with, and the `cdk watch` loop of `npm run sandbox` now watches every stack too. Before, an app with more than one stack could not be deployed or destroyed to production: CDK refused with "specify which stacks to use". Examples are an app with `Hosting` and a Lambda@Edge function (an edge-runtime route or Next.js middleware) deployed outside us-east-1, which adds an `edge-lambda-stack-*` stack, or an app with an extra stack of its own, such as one for an `ec2.Vpc.fromLookup`. The sandbox's `cdk watch` on such an app never redeployed and showed no error. A single-stack app deploys and destroys the same stack as before.

`npm run destroy` deletes every stack of the app without asking, dependent stacks first; resources with a `RETAIN` removal policy are kept. If your app also defines a stack you deploy and delete on its own, move it to a separate CDK app before running `npm run destroy`. The deploy now reads the API URL from the stack that has the `ApiUrl` output, rather than from the first stack in the outputs file.
