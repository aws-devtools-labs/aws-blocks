---
"@aws-blocks/bb-data": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

A retained Aurora cluster (`removalPolicy` retain, the `production` default) now keeps what it needs on `cdk destroy`: its security group, the VPC Blocks created for it (subnets, route tables and their associations) and its generated credentials secret are retained with it, so destroying a production stack completes instead of failing on resources the kept cluster still uses. Under `removalPolicy: 'snapshot'` the generated credentials secret is retained. A VPC you provide is not changed. Existing stacks pick this up on the next deploy without replacing any resource.

`npm run destroy` now lists the resources a production destroy kept (type, logical id, physical id), which keep running until you delete them. When a destroy fails because a retained resource still uses something the stack deletes, `npm run destroy` and `npm run sandbox:destroy` stop after that attempt, list the resources involved and exit with code 1, instead of emptying buckets and retrying.
