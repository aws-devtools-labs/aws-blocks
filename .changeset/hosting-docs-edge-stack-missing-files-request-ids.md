---
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/core': patch
'aws-cdk-blocks': patch
---

Docs: the hosting and core READMEs now describe three behaviours that were undocumented:

- The `us-east-1` stack that holds Lambda@Edge functions outside `us-east-1` keeps CDK's name, `edge-lambda-stack-<hash>`, unless `defaults.appIdentity` names it `<id>-edge` (or `HostingConstruct`'s `edgeStackId` is set). The READMEs say how to find it and how to delete it after the app stack.
- On the CloudFront door, a missing static file with no 404 page to map it to answers with S3's `NoSuchKey` XML (`404`, `application/xml`), while the ALB and API Gateway doors' asset proxy answers with the app's 404 page or a plain `Not Found`. The README no longer says the asset proxy answers "like the CloudFront door".
- A new "Header hygiene" section lists the internal headers Hosting removes and the request-id headers it keeps (`x-amzn-requestid`, `x-amz-apigw-id`, `apigw-requestid`, `lambda-web-request-id`), and shows how to remove the ones CloudFront allows with your own `frontDoor.features.responseHeadersPolicy`.
